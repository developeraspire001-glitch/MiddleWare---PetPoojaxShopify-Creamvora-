import { describe, it, expect, vi, afterEach } from "vitest";
import { findCakeMapping, getCakeMappings, resolveCakeMapping, CakeItemMapping } from "@/src/config/cake-mappings";
import { PetpoojaOrderMapper } from "@/src/integrations/petpooja/petpooja.order.mapper";
import { ShopifyOrderWebhook, ShopifyOrderWebhookSchema } from "@/src/integrations/shopify/shopify.types";

// Test fixtures only; production mappings come from cake-mappings.json / CAKE_MAPPINGS_JSON.
const mappings: CakeItemMapping[] = [
  {
    cakeName: "Truffle Cake (500g)",
    shopifyVariantId: "1001",
    shopifyProductId: "500",
    shopifySku: "TRUFFLE-500",
    shopifyTitle: "Truffle Cake (500g)",
    petpoojaItemId: "PP_TRUFFLE",
    petpoojaVariationId: "PP_VAR_500",
    petpoojaVariationName: "500 Gm",
    petpoojaItemName: "Truffle Cake",
  },
  {
    cakeName: "Truffle Cake (1kg)",
    shopifyVariantId: "1002",
    shopifyProductId: "500",
    shopifySku: "TRUFFLE-1KG",
    shopifyTitle: "Truffle Cake (1kg)",
    petpoojaItemId: "PP_TRUFFLE",
    petpoojaVariationId: "PP_VAR_1KG",
    petpoojaVariationName: "1 Kg",
    petpoojaItemName: "Truffle Cake",
  },
  {
    cakeName: "Biscoff Cake",
    shopifyProductId: "600",
    petpoojaItemId: "PP_BISCOFF",
    petpoojaItemName: "Lotus Biscoff Cake",
  },
];

const line = (overrides: Record<string, unknown>) => ({
  id: 1,
  title: "Some Cake",
  quantity: 1,
  price: "500.00",
  ...overrides,
});

function buildOrder(lineItems: Record<string, unknown>[]): ShopifyOrderWebhook {
  return ShopifyOrderWebhookSchema.parse({
    id: 9001,
    name: "#9001",
    order_number: 9001,
    created_at: "2026-11-01T10:00:00Z",
    financial_status: "paid",
    total_price: "0.00",
    subtotal_price: "0.00",
    line_items: lineItems,
  });
}

const mapperOptions = { appKey: "k", appSecret: "s", accessToken: "t", restId: "r" };

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CAKE_MAPPINGS_JSON;
});

describe("resolveCakeMapping", () => {
  it("prefers the exact variant over another size sharing the same product ID", () => {
    const result = resolveCakeMapping(
      { id: 1, product_id: 500, variant_id: 1002, title: "Truffle Cake", variant_title: "1kg" },
      mappings
    );
    expect(result.matchedBy).toBe("variant_id");
    expect(result.mapping?.petpoojaVariationId).toBe("PP_VAR_1KG");
  });

  it("matches by SKU when the variant ID is not mapped", () => {
    const result = resolveCakeMapping({ id: 1, product_id: 500, variant_id: 7777, sku: " truffle-1kg ", title: "Truffle Cake (1kg)" }, mappings);
    expect(result.matchedBy).toBe("sku");
    expect(result.mapping?.cakeName).toBe("Truffle Cake (1kg)");
  });

  it("matches by product ID only when the product maps to a single Petpooja item", () => {
    const result = resolveCakeMapping({ id: 1, product_id: 600, variant_id: 8888, title: "Biscoff" }, mappings);
    expect(result.matchedBy).toBe("product_id");
    expect(result.mapping?.petpoojaItemId).toBe("PP_BISCOFF");
  });

  it("disambiguates a multi-size product by title + variant title", () => {
    const result = resolveCakeMapping(
      { id: 1, product_id: 500, variant_id: 9999, title: "Truffle Cake", variant_title: "1kg" },
      mappings
    );
    expect(result.matchedBy).toBe("title");
    expect(result.mapping?.petpoojaVariationId).toBe("PP_VAR_1KG");
  });

  it("refuses to guess when a multi-size product cannot be disambiguated", () => {
    const result = resolveCakeMapping(
      { id: 1, product_id: 500, variant_id: 9999, title: "Truffle Cake", variant_title: "2kg" },
      mappings
    );
    expect(result.mapping).toBeUndefined();
    expect(result.reason).toContain("Shopify product 500");
  });

  it("uses the selected size to distinguish variants with the same title and blank SKU", () => {
    const entries: CakeItemMapping[] = [
      { cakeName: "Test Cake 500", shopifyTitle: "Test Cake", shopifyVariantTitle: "500 GM", petpoojaItemId: "10", petpoojaVariationId: "101" },
      { cakeName: "Test Cake 850", shopifyTitle: "Test Cake", shopifyVariantTitle: "850 GM", petpoojaItemId: "10", petpoojaVariationId: "102" },
    ];
    const result = resolveCakeMapping({ id: 1, title: "Test Cake", variant_title: "850 GM", sku: "" }, entries);
    expect(result.matchedBy).toBe("title_variant");
    expect(result.mapping?.petpoojaVariationId).toBe("102");
  });

  it("never chooses the first of two conflicting Petpooja targets sharing a SKU", () => {
    const entries: CakeItemMapping[] = [
      { cakeName: "First", shopifySku: "DUPLICATE", petpoojaItemId: "10" },
      { cakeName: "Second", shopifySku: "DUPLICATE", petpoojaItemId: "20" },
    ];
    expect(resolveCakeMapping({ id: 1, title: "Unknown", sku: "DUPLICATE" }, entries).mapping).toBeUndefined();
  });

  it("does not misroute unmapped Chocolate Cherry Bliss to Hazelnut Rocher via a reused SKU", () => {
    const entries: CakeItemMapping[] = [
      { cakeName: "Rocher 600", shopifyTitle: "The Hazelnut Chocolate Rocher", shopifyVariantTitle: "600 GM", shopifySku: "CVHC -50", petpoojaItemId: "1312471963", petpoojaVariationId: "1312471986" },
      { cakeName: "Rocher 1 KG", shopifyTitle: "The Hazelnut Chocolate Rocher", shopifyVariantTitle: "1 KG", shopifySku: "CVHC -100", petpoojaItemId: "1312471963", petpoojaVariationId: "1312471987" },
    ];
    expect(resolveCakeMapping({ id: 1, title: "Chocolate Cherry Bliss", variant_title: "600 GM", sku: "CVHC -50" }, entries).mapping).toBeUndefined();
    expect(resolveCakeMapping({ id: 2, title: "Chocolate Cherry Bliss", variant_title: "1000 GM", sku: "CVHC -100" }, entries).mapping).toBeUndefined();
  });

  it("does not use a stale SKU to override the selected variant size", () => {
    const entries: CakeItemMapping[] = [
      { cakeName: "Rocher 600", shopifyTitle: "The Hazelnut Chocolate Rocher", shopifyVariantTitle: "600 GM", shopifySku: "CVHC -50", petpoojaItemId: "1312471963", petpoojaVariationId: "1312471986" },
    ];
    expect(resolveCakeMapping({ id: 1, title: "The Hazelnut Chocolate Rocher", variant_title: "1 KG", sku: "CVHC -50" }, entries).mapping).toBeUndefined();
  });

  it("does not match a line item ID against mapped variant IDs", () => {
    expect(findCakeMapping({ id: 1001, variant_id: 5, title: "Unknown" }, mappings)).toBeUndefined();
  });
});

describe("getCakeMappings", () => {
  it("uses CAKE_MAPPINGS_JSON when it is a valid array and drops entries without petpoojaItemId", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.CAKE_MAPPINGS_JSON = JSON.stringify([mappings[0], { cakeName: "Broken" }]);
    const result = getCakeMappings();
    expect(result).toHaveLength(1);
    expect(result[0].petpoojaItemId).toBe("PP_TRUFFLE");
  });

  it("logs an error and falls back to the JSON file when CAKE_MAPPINGS_JSON is invalid", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.CAKE_MAPPINGS_JSON = "{not json";
    const result = getCakeMappings();
    expect(result.length).toBeGreaterThan(0);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("CAKE_MAPPINGS_JSON could not be parsed"));
  });
});

describe("PetpoojaOrderMapper line item mapping", () => {
  it("maps every cake in a multi-line order to its own Petpooja item and variation", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const order = buildOrder([
      line({ id: 1, product_id: 500, variant_id: 1001, title: "Truffle Cake", variant_title: "500g", quantity: 2 }),
      line({ id: 2, product_id: 500, variant_id: 1002, title: "Truffle Cake", variant_title: "1kg" }),
      line({ id: 3, product_id: 600, variant_id: 3003, title: "Biscoff Cake", variant_title: "Default Title" }),
    ]);

    const items = PetpoojaOrderMapper.toPetpoojaPayload(order, mappings, mapperOptions).orderinfo.OrderInfo.OrderItem.details;

    expect(items.map((i) => [i.id, i.variation_id, i.variation_name, i.name, i.quantity])).toEqual([
      ["PP_TRUFFLE", "PP_VAR_500", "500 Gm", "Truffle Cake", "2"],
      ["PP_TRUFFLE", "PP_VAR_1KG", "1 Kg", "Truffle Cake", "1"],
      ["PP_BISCOFF", "", "", "Lotus Biscoff Cake", "1"],
    ]);
  });

  it("still syncs unmapped lines but logs a warning naming the Shopify product", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const order = buildOrder([
      line({ id: 1, product_id: 500, variant_id: 1001, title: "Truffle Cake", variant_title: "500g" }),
      line({ id: 2, product_id: 777, variant_id: 7070, sku: "NEW-CAKE", title: "Brand New Cake", variant_title: "1kg" }),
    ]);

    const items = PetpoojaOrderMapper.toPetpoojaPayload(order, mappings, mapperOptions).orderinfo.OrderInfo.OrderItem.details;

    expect(items).toHaveLength(2);
    expect(items[0].id).toBe("PP_TRUFFLE");
    expect(items[1].id).toBe("NEW-CAKE");
    expect(items[1].variation_id).toBe("");

    const logs = warnSpy.mock.calls.map((c) => JSON.parse(String(c[0])));
    const lineWarning = logs.find((l) => l.message.startsWith("UNMAPPED SHOPIFY PRODUCT"));
    expect(lineWarning).toMatchObject({
      orderId: "9001",
      shopifyProductId: "777",
      shopifyVariantId: "7070",
      sku: "NEW-CAKE",
      title: "Brand New Cake",
    });
    expect(logs.find((l) => l.unmappedCount === 1)).toBeDefined();
  });

  it("uses the configured mapping file when the webhook passes no mappings", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const [first] = getCakeMappings();
    const order = buildOrder([line({
      id: 1,
      variant_id: first.shopifyVariantId || 9000001,
      title: first.shopifyTitle || first.cakeName,
      variant_title: first.shopifyVariantTitle || "Default Title",
      sku: first.shopifySku || "",
    })]);

    const [item] = PetpoojaOrderMapper.toPetpoojaPayload(order, null, mapperOptions).orderinfo.OrderInfo.OrderItem.details;

    expect(item.id).toBe(first.petpoojaItemId);
  });
});
