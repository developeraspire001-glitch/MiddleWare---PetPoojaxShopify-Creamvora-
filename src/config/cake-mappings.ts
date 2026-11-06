import defaultCakeMappings from "./cake-mappings.json";
import { logger } from "@/src/lib/logger";

export interface CakeItemMapping {
  cakeName: string;
  shopifyVariantId?: string | number;
  shopifyProductId?: string | number;
  shopifySku?: string;
  shopifyTitle?: string;
  /** Shopify option combination, e.g. "500 GM / Sugar-Free". */
  shopifyVariantTitle?: string;
  petpoojaItemId: string;
  petpoojaVariationId?: string;
  petpoojaVariationName?: string;
  petpoojaItemName?: string;
}

export interface CakeMappingLineItem {
  id: string | number;
  variant_id?: string | number | null;
  product_id?: string | number | null;
  sku?: string | null;
  title: string;
  variant_title?: string | null;
  name?: string | null;
}

export type CakeMappingMatchType = "variant_id" | "title_variant" | "sku" | "product_id" | "title";

export interface CakeMappingResolution {
  mapping?: CakeItemMapping;
  matchedBy?: CakeMappingMatchType;
  /** Human-readable reason when no mapping could be resolved. */
  reason?: string;
}

/**
 * Drops entries that cannot be used for order sync (no Petpooja item ID).
 */
function sanitizeMappings(raw: unknown[], source: string): CakeItemMapping[] {
  return raw.filter((entry, idx): entry is CakeItemMapping => {
    const m = entry as Partial<CakeItemMapping> | null;
    if (!m || typeof m !== "object" || !m.petpoojaItemId || !String(m.petpoojaItemId).trim()) {
      logger.warn("Cake mapping entry ignored: missing petpoojaItemId", {
        source,
        index: idx,
        cakeName: m?.cakeName,
      });
      return false;
    }
    return true;
  });
}

/**
 * Returns all active cake mappings.
 * Supports dynamic override via process.env.CAKE_MAPPINGS_JSON if set in Vercel.
 */
export function getCakeMappings(): CakeItemMapping[] {
  if (process.env.CAKE_MAPPINGS_JSON) {
    try {
      const parsed = JSON.parse(process.env.CAKE_MAPPINGS_JSON);
      if (Array.isArray(parsed)) {
        return sanitizeMappings(parsed, "CAKE_MAPPINGS_JSON");
      }
      logger.error(
        "CAKE_MAPPINGS_JSON is not a JSON array; falling back to src/config/cake-mappings.json",
        undefined,
        { receivedType: typeof parsed }
      );
    } catch (err) {
      logger.error(
        "CAKE_MAPPINGS_JSON could not be parsed; falling back to src/config/cake-mappings.json",
        err
      );
    }
  }

  return sanitizeMappings(defaultCakeMappings as unknown[], "cake-mappings.json");
}

const normId = (v: string | number | null | undefined) =>
  v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim();

const normText = (v: string | null | undefined) =>
  v && v.trim() ? v.trim().toLowerCase().replace(/\s*\/\s*/g, " / ").replace(/\s+/g, " ") : null;

/**
 * Resolves the Petpooja item for a Shopify line item.
 *
 * Matching is tiered from most to least specific, and each tier is evaluated
 * across ALL mappings before falling through to the next one:
 *   1. Shopify Variant ID  (exact cake + size)
 *   2. Shopify SKU
 *   3. Shopify Product ID  (only when it identifies a single Petpooja item;
 *                           products with several sizes need variant/SKU mappings)
 *   4. Title / cake name   (line title, or "title - variant" line name)
 */
export function resolveCakeMapping(
  line: CakeMappingLineItem,
  customMappings?: CakeItemMapping[] | null
): CakeMappingResolution {
  const mappings = customMappings && customMappings.length > 0 ? customMappings : getCakeMappings();

  const varIdStr = normId(line.variant_id);
  const prodIdStr = normId(line.product_id);
  const skuStr = normText(line.sku);

  // Only consider a match safe when all candidates select the same POS item+variation.
  // A duplicate Shopify SKU must never arbitrarily select the first matching cake.
  const uniqueTarget = (candidates: CakeItemMapping[]): CakeItemMapping | undefined => {
    if (!candidates.length) return undefined;
    const target = (m: CakeItemMapping) => `${m.petpoojaItemId}|${m.petpoojaVariationId || ""}`;
    return candidates.every((m) => target(m) === target(candidates[0])) ? candidates[0] : undefined;
  };

  // 1. Shopify variant ID: strongest identity, when it is available.
  if (varIdStr) {
    const match = uniqueTarget(mappings.filter((m) => normId(m.shopifyVariantId) === varIdStr));
    if (match) return { mapping: match, matchedBy: "variant_id" };
  }

  // 2. Exact product title + Shopify option combination: handles blank/reused SKUs.
  // Only new entries containing shopifyVariantTitle are eligible for this tier.
  const shopifyTitle = normText(line.title);
  const shopifyVariantTitle = normText(line.variant_title);
  if (shopifyTitle && shopifyVariantTitle) {
    const match = uniqueTarget(mappings.filter((m) =>
      normText(m.shopifyTitle) === shopifyTitle &&
      normText(m.shopifyVariantTitle) === shopifyVariantTitle
    ));
    if (match) return { mapping: match, matchedBy: "title_variant" };
  }

  // 3. SKU fallback: a SKU cannot override a different Shopify product or size.
  // Shopify's export may reuse a SKU on a product that is NOT in the mapping file.
  // Therefore checking uniqueness among mappings alone is not sufficient.
  if (skuStr) {
    const compatible = mappings.filter((m) =>
      normText(m.shopifySku) === skuStr &&
      (!m.shopifyTitle || normText(m.shopifyTitle) === shopifyTitle) &&
      (!m.shopifyVariantTitle || normText(m.shopifyVariantTitle) === shopifyVariantTitle)
    );
    const match = uniqueTarget(compatible);
    if (match) return { mapping: match, matchedBy: "sku" };
  }

  // 4. Product ID: only for an unambiguous, single POS target.
  let ambiguousProductCandidates: CakeItemMapping[] = [];
  if (prodIdStr) {
    const candidates = mappings.filter((m) => normId(m.shopifyProductId) === prodIdStr);
    const match = uniqueTarget(candidates);
    if (match) return { mapping: match, matchedBy: "product_id" };
    ambiguousProductCandidates = candidates;
  }

  // 5. Name fallback: do not guess if a cake has several mapped weights/types.
  const titleCandidates = [normText(line.name), normText(line.title)].filter(
    (t): t is string => Boolean(t)
  );
  if (line.title && line.variant_title) {
    titleCandidates.push(normText(`${line.title} (${line.variant_title})`)!);
  }
  if (titleCandidates.length > 0) {
    const pools = ambiguousProductCandidates.length > 0
      ? [ambiguousProductCandidates, mappings]
      : [mappings];
    for (const pool of pools) {
      const candidates = pool.filter((m) => {
        const mapTitles = [normText(m.shopifyTitle), normText(m.cakeName)];
        return mapTitles.some((t) => t && titleCandidates.includes(t)) &&
          (!m.shopifyVariantTitle || normText(m.shopifyVariantTitle) === shopifyVariantTitle);
      });
      const match = uniqueTarget(candidates);
      if (match) return { mapping: match, matchedBy: "title" };
    }
  }

  if (ambiguousProductCandidates.length > 0) {
    return {
      reason:
        `Shopify product ${prodIdStr} maps to ${ambiguousProductCandidates.length} different Petpooja items ` +
        `(${ambiguousProductCandidates.map((m) => m.cakeName).join(", ")}) and variant ${varIdStr ?? "n/a"} ` +
        `/ SKU ${line.sku || "n/a"} is not mapped; add a shopifyVariantId or shopifySku mapping for this variant`,
    };
  }

  return {
    reason: "No unique cake mapping matches this Shopify variant ID, title+size, SKU, product ID or title",
  };
}

/**
 * Resolves a Petpooja Item ID parallel to a Shopify line item.
 * Searches by Shopify Variant ID, SKU, Product ID, or Product Title (in that order).
 */
export function findCakeMapping(
  line: CakeMappingLineItem,
  customMappings?: CakeItemMapping[] | null
): CakeItemMapping | undefined {
  return resolveCakeMapping(line, customMappings).mapping;
}
