/**
 * Token bucket rate limiter.
 * Flickr allows 3,600 requests/hour per key. We target 3,000 to leave headroom,
 * with a small burst capacity for quick sequential lookups.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRatePerMs: number; // tokens per millisecond

  constructor(requestsPerHour = 3000) {
    this.maxTokens = 10;
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
    this.refillRatePerMs = requestsPerHour / (60 * 60 * 1000);
  }

  async consume(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Wait until we have a token
    const waitMs = Math.ceil((1 - this.tokens) / this.refillRatePerMs);
    await new Promise(resolve => setTimeout(resolve, waitMs));
    this.refill();
    this.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRatePerMs);
    this.lastRefill = now;
  }
}
