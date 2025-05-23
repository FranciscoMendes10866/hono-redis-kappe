import type { Context, MiddlewareHandler, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import { RateLimiterRedis, type RateLimiterRes } from "rate-limiter-flexible";
import type { Redis } from "ioredis";

export interface IKeyGenerator {
  generateKey(c: Context): string;
}

export interface IErrorResponseHandler {
  handleError(
    c: Context,
    rateLimiterRes: RateLimiterRes,
  ): Response | Promise<Response>;
}

export interface IRateLimitService {
  checkLimit(key: string): Promise<RateLimiterRes>;
  getConfiguration(): RateLimitConfiguration;
}

export interface IHeaderManager {
  setRateLimitHeaders(
    c: Context,
    config: RateLimitConfiguration,
    rateLimiterRes: RateLimiterRes,
  ): void;
  setErrorHeaders(c: Context, rateLimiterRes: RateLimiterRes): void;
}

export interface RateLimitConfiguration {
  readonly requestLimit: number;
  readonly timeWindowSeconds: number;
  readonly keyPrefix: string;
}

export class ImmutableRateLimitConfiguration implements RateLimitConfiguration {
  readonly requestLimit: number;
  readonly timeWindowSeconds: number;
  readonly keyPrefix: string;

  constructor(config: RateLimitConfiguration) {
    this.requestLimit = config.requestLimit;
    this.timeWindowSeconds = config.timeWindowSeconds;
    this.keyPrefix = config.keyPrefix;

    Object.freeze(this);
  }

  with(
    updates: Partial<RateLimitConfiguration>,
  ): ImmutableRateLimitConfiguration {
    return new ImmutableRateLimitConfiguration({
      requestLimit: updates.requestLimit ?? this.requestLimit,
      timeWindowSeconds: updates.timeWindowSeconds ?? this.timeWindowSeconds,
      keyPrefix: updates.keyPrefix ?? this.keyPrefix,
    });
  }

  toPlainObject(): RateLimitConfiguration {
    return structuredClone({
      requestLimit: this.requestLimit,
      timeWindowSeconds: this.timeWindowSeconds,
      keyPrefix: this.keyPrefix,
    });
  }
}

export interface RateLimiterOptions {
  redis: Redis;
  requestLimit?: number;
  timeWindowSeconds?: number;
  keyPrefix?: string;
  keyGenerator?: IKeyGenerator;
  errorResponseHandler?: IErrorResponseHandler;
  headerManager?: IHeaderManager;
}

export class ImmutableRateLimiterOptions {
  readonly redis: Redis;
  readonly requestLimit: number;
  readonly timeWindowSeconds: number;
  readonly keyPrefix: string;
  readonly keyGenerator: IKeyGenerator;
  readonly errorResponseHandler: IErrorResponseHandler;
  readonly headerManager: IHeaderManager;

  constructor(options: RateLimiterOptions) {
    this.redis = options.redis;
    this.requestLimit = options.requestLimit ?? 10;
    this.timeWindowSeconds = options.timeWindowSeconds ?? 60;
    this.keyPrefix = options.keyPrefix ?? "rate_limit";
    this.keyGenerator = options.keyGenerator ?? new IpBasedKeyGenerator();
    this.errorResponseHandler =
      options.errorResponseHandler ?? new DefaultErrorResponseHandler();
    this.headerManager = options.headerManager ?? new RateLimitHeaderManager();

    Object.freeze(this);
  }

  toConfiguration(): ImmutableRateLimitConfiguration {
    return new ImmutableRateLimitConfiguration({
      requestLimit: this.requestLimit,
      timeWindowSeconds: this.timeWindowSeconds,
      keyPrefix: this.keyPrefix,
    });
  }
}

export class IpBasedKeyGenerator implements IKeyGenerator {
  generateKey(c: Context): string {
    return (
      c.req.header("x-forwarded-for") ||
      c.env?.cf?.ip ||
      c.req.header("x-real-ip") ||
      "unknown"
    );
  }
}

export class FunctionBasedKeyGenerator implements IKeyGenerator {
  constructor(private readonly keyFunction: (c: Context) => string) {}

  generateKey(c: Context): string {
    return this.keyFunction(c);
  }
}

export class DefaultErrorResponseHandler implements IErrorResponseHandler {
  handleError(c: Context, rateLimiterRes: RateLimiterRes): Response {
    const retryAfter = Math.ceil(rateLimiterRes.msBeforeNext / 1000);

    throw new HTTPException(429, {
      message: `Too many requests, please try again in ${retryAfter} seconds`,
    });
  }
}

export class JsonErrorResponseHandler implements IErrorResponseHandler {
  private readonly includeDetails: boolean;

  constructor(includeDetails: boolean = true) {
    this.includeDetails = includeDetails;
    Object.freeze(this);
  }

  handleError(c: Context, rateLimiterRes: RateLimiterRes): Response {
    const retryAfter = Math.ceil(rateLimiterRes.msBeforeNext / 1000);

    const baseErrorBody = {
      error: "Rate limit exceeded",
      message: "Too many requests",
    };

    const detailsBody = this.includeDetails
      ? {
          retryAfter,
          resetTime: new Date(
            Date.now() + rateLimiterRes.msBeforeNext,
          ).toISOString(),
        }
      : {};

    const errorBody = structuredClone({ ...baseErrorBody, ...detailsBody });

    return new Response(JSON.stringify(errorBody), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export class RateLimitHeaderManager implements IHeaderManager {
  setRateLimitHeaders(
    c: Context,
    config: RateLimitConfiguration,
    rateLimiterRes: RateLimiterRes,
  ): void {
    c.header("X-RateLimit-Limit", String(config.requestLimit));
    c.header("X-RateLimit-Remaining", String(rateLimiterRes.remainingPoints));
    c.header(
      "X-RateLimit-Reset",
      String(Math.ceil(rateLimiterRes.msBeforeNext / 1000)),
    );
  }

  setErrorHeaders(c: Context, rateLimiterRes: RateLimiterRes): void {
    const retryAfter = Math.ceil(rateLimiterRes.msBeforeNext / 1000);
    c.header("Retry-After", String(retryAfter));
    c.header("X-RateLimit-Remaining", "0");
  }
}

export class RedisRateLimitService implements IRateLimitService {
  private readonly limiter: RateLimiterRedis;
  private readonly config: ImmutableRateLimitConfiguration;

  constructor(redis: Redis, config: RateLimitConfiguration) {
    this.config = new ImmutableRateLimitConfiguration(config);

    this.limiter = new RateLimiterRedis({
      storeClient: redis,
      points: this.config.requestLimit,
      duration: this.config.timeWindowSeconds,
      keyPrefix: this.config.keyPrefix,
    });

    Object.freeze(this);
  }

  async checkLimit(key: string): Promise<RateLimiterRes> {
    return await this.limiter.consume(key);
  }

  getConfiguration(): RateLimitConfiguration {
    return this.config.toPlainObject();
  }
}

export class RateLimiterMiddleware {
  private readonly rateLimitService: IRateLimitService;
  private readonly keyGenerator: IKeyGenerator;
  private readonly errorResponseHandler: IErrorResponseHandler;
  private readonly headerManager: IHeaderManager;

  constructor(
    rateLimitService: IRateLimitService,
    keyGenerator: IKeyGenerator,
    errorResponseHandler: IErrorResponseHandler,
    headerManager: IHeaderManager,
  ) {
    this.rateLimitService = rateLimitService;
    this.keyGenerator = keyGenerator;
    this.errorResponseHandler = errorResponseHandler;
    this.headerManager = headerManager;

    Object.freeze(this);
  }

  create(): MiddlewareHandler {
    return async (c: Context, next: Next) => {
      const key = this.keyGenerator.generateKey(c);
      const config = this.rateLimitService.getConfiguration();
      try {
        const rateLimiterRes = await this.rateLimitService.checkLimit(key);
        this.headerManager.setRateLimitHeaders(c, config, rateLimiterRes);
        return await next();
      } catch (error) {
        if (this.isRateLimitError(error)) {
          const rateLimiterRes = error as unknown as RateLimiterRes;
          this.headerManager.setErrorHeaders(c, rateLimiterRes);
          this.headerManager.setRateLimitHeaders(c, config, rateLimiterRes);
          return this.errorResponseHandler.handleError(c, rateLimiterRes);
        }
        throw error;
      }
    };
  }

  private isRateLimitError(error: unknown): boolean {
    return error instanceof Error && "remainingPoints" in error;
  }
}

export class RateLimiterFactory {
  static create(options: RateLimiterOptions): MiddlewareHandler {
    const immutableOptions = new ImmutableRateLimiterOptions(options);
    const config = immutableOptions.toConfiguration();

    const rateLimitService = new RedisRateLimitService(
      immutableOptions.redis,
      config.toPlainObject(),
    );

    const middleware = new RateLimiterMiddleware(
      rateLimitService,
      immutableOptions.keyGenerator,
      immutableOptions.errorResponseHandler,
      immutableOptions.headerManager,
    );

    return middleware.create();
  }

  static createReusableFactory(baseOptions: Partial<RateLimiterOptions>) {
    const frozenBaseOptions = Object.freeze(structuredClone(baseOptions));

    return (overrideOptions: RateLimiterOptions) => {
      const mergedOptions = {
        ...structuredClone(frozenBaseOptions),
        ...structuredClone(overrideOptions),
      };

      return RateLimiterFactory.create(mergedOptions);
    };
  }
}
