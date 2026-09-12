import { AssetsManager, type GetImageOptions } from "@gi-tcg/assets-manager";

const LOCAL_CARD_IMAGES_BASE = "/card_images";

/**
 * AssetsManager that tries local card_images first, falling back to remote API.
 * The vite dev server middleware serves /card_images/{id} from local directories.
 *
 * When the remote API is unhealthy (returning errors), we skip API calls entirely
 * and return local URLs so the browser gets a quick 404 → fallback renders immediately
 * instead of waiting for a slow API timeout.
 */
export class LocalAssetsManager extends AssetsManager {
  private checkedIds = new Map<number, boolean>();

  /** Timestamp of last API health check failure; 0 = unknown/healthy. */
  private lastApiFailure = 0;

  /** Seconds to wait before retrying API after a failure. */
  private readonly API_COOLDOWN_MS = 30_000;

  private isApiLikelyDown(): boolean {
    return this.lastApiFailure > 0 && (Date.now() - this.lastApiFailure) < this.API_COOLDOWN_MS;
  }

  private markApiFailure(): void {
    this.lastApiFailure = Date.now();
  }

  getImageUrlSync(id: number, options: GetImageOptions = {}): string {
    if (id === 0) return super.getImageUrlSync(id, options);
    const known = this.checkedIds.get(id);
    if (known === false) return super.getImageUrlSync(id, options);
    return `${LOCAL_CARD_IMAGES_BASE}/${id}`;
  }

  async getImageUrl(
    id: number,
    options: GetImageOptions = {},
  ): Promise<string> {
    if (id === 0) return super.getImageUrl(id, options);

    const known = this.checkedIds.get(id);
    if (known === true) return `${LOCAL_CARD_IMAGES_BASE}/${id}`;

    // If API has been failing recently, skip straight to local URL
    // (which will 404 quickly → Image component renders fallback immediately)
    if (known === false && this.isApiLikelyDown()) {
      return `${LOCAL_CARD_IMAGES_BASE}/${id}`;
    }

    // Try local cache first
    try {
      const resp = await fetch(`${LOCAL_CARD_IMAGES_BASE}/${id}`);
      if (resp.ok) {
        this.checkedIds.set(id, true);
        return `${LOCAL_CARD_IMAGES_BASE}/${id}`;
      }
    } catch {
      // ignore — fall through
    }

    // Local cache miss — try remote API
    if (!this.isApiLikelyDown()) {
      try {
        const url = await super.getImageUrl(id, options);
        // API succeeded — mark as healthy, cache the result
        this.lastApiFailure = 0;
        return url;
      } catch {
        this.markApiFailure();
      }
    }

    // API is down or failed — return local URL so fallback renders
    return `${LOCAL_CARD_IMAGES_BASE}/${id}`;
  }
}

export const LOCAL_ASSETS_MANAGER = new LocalAssetsManager();
