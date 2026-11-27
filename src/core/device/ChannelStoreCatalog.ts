/*---------------------------------------------------------------------------------------------
 *  BrightScript Engine (https://github.com/lvcabral/brs-engine)
 *
 *  Copyright (c) 2019-2026 Marcelo Lv Cabral. All Rights Reserved.
 *
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/
import { genHexAddress } from "../common";
import type { ChannelStoreMock, ChannelStoreProduct, ChannelStorePurchase } from "../common";

/// #if !BROWSER
import * as fs from "node:fs";
import * as path from "node:path";
/// #endif

/** How `DoOrder` completes when `fakeServer` is off. */
export type ChannelStoreOrderOutcome = "success" | "cancel" | "failure";

/** A catalog or purchase row, using the field names a device puts on the response. */
export interface ChannelStoreRecord {
    [key: string]: string | number;
}

interface SessionState {
    products: ChannelStoreProduct[];
    purchases: ChannelStorePurchase[];
    orderResult: ChannelStoreOrderOutcome;
}

const emptySession = (): SessionState => ({ products: [], purchases: [], orderResult: "success" });

/** Baseline loaded from the host, copied into `session` at configure time. */
let baseline: SessionState = emptySession();
/** Purchases made during this interpreter's run are appended here. */
let session: SessionState = emptySession();

/**
 * Loads the host's channel-store mock and resets the session purchase list to that baseline.
 * Called when a device is configured, so each app run starts from the file rather than from
 * purchases recorded by the previous run.
 * @param source Parsed mock, a filesystem path (Node), or undefined for an empty catalog.
 * @returns A warning string when the source could not be used, otherwise undefined.
 */
export function configureChannelStore(source: string | ChannelStoreMock | undefined): string | undefined {
    const loaded = normalizeSource(source);
    baseline = loaded.state;
    session = cloneSession(baseline);
    return loaded.warning;
}

/** The configured `DoOrder` outcome. Defaults to success. */
export function channelStoreOrderOutcome(): ChannelStoreOrderOutcome {
    return session.orderResult;
}

/** Catalog rows for `GetCatalog` and `GetStoreCatalog` (`cost` is the mock's `price`). */
export function channelStoreCatalogRecords(): ChannelStoreRecord[] {
    const records: ChannelStoreRecord[] = [];
    for (const product of session.products) {
        records.push(catalogRecord(product));
    }
    return records;
}

/**
 * Purchase rows. `GetPurchases` is the active (`Valid`) list; `GetAllPurchases` includes
 * expired (`Invalid`) entries as well.
 * @param includeExpired When true, expired purchases are included.
 */
export function channelStorePurchaseRecords(includeExpired: boolean): ChannelStoreRecord[] {
    const records: ChannelStoreRecord[] = [];
    for (const purchase of session.purchases) {
        if (!includeExpired && isExpired(purchase.status)) {
            continue;
        }
        records.push(purchaseRecord(purchase));
    }
    return records;
}

/** Looks up a catalog product by its code. */
export function channelStoreProduct(code: string): ChannelStoreProduct | undefined {
    for (const product of session.products) {
        if (product.code === code) {
            return product;
        }
    }
    return undefined;
}

/**
 * Records a successful purchase for the rest of this session.
 * @param purchase Purchase to append. `purchaseId` and `purchaseDate` are filled in when omitted.
 * @returns The purchase id stored on the row.
 */
export function recordChannelStorePurchase(purchase: ChannelStorePurchase): string {
    const purchaseId = purchase.purchaseId || genHexAddress();
    session.purchases.push({
        code: purchase.code,
        name: purchase.name,
        price: purchase.price,
        productType: purchase.productType,
        qty: purchase.qty ?? 1,
        purchaseId,
        purchaseDate: purchase.purchaseDate || new Date().toISOString(),
        status: "Valid",
    });
    return purchaseId;
}

function cloneSession(source: SessionState): SessionState {
    return {
        products: source.products.map((product) => ({ ...product })),
        purchases: source.purchases.map((purchase) => ({ ...purchase })),
        orderResult: source.orderResult,
    };
}

function normalizeSource(source: string | ChannelStoreMock | undefined): { state: SessionState; warning?: string } {
    if (source == null || source === "") {
        return { state: emptySession() };
    }
    if (typeof source === "string") {
        const loaded = readChannelStoreFile(source);
        if (loaded.warning) {
            return { state: emptySession(), warning: loaded.warning };
        }
        return normalizeMock(loaded.mock);
    }
    return normalizeMock(source);
}

function normalizeMock(mock: ChannelStoreMock | undefined): { state: SessionState; warning?: string } {
    const state = emptySession();
    if (mock == null || typeof mock !== "object" || Array.isArray(mock)) {
        return { state, warning: "Channel store mock must be a JSON object; using an empty catalog." };
    }
    if (Array.isArray(mock.products)) {
        for (const entry of mock.products) {
            const product = normalizeProduct(entry);
            if (product) {
                state.products.push(product);
            }
        }
    }
    if (Array.isArray(mock.purchases)) {
        for (const entry of mock.purchases) {
            const purchase = normalizePurchase(entry);
            if (purchase) {
                state.purchases.push(purchase);
            }
        }
    }
    const outcome = normalizeOutcome(mock.orderResult);
    state.orderResult = outcome.outcome;
    return { state, warning: outcome.warning };
}

function normalizeOutcome(value: unknown): { outcome: ChannelStoreOrderOutcome; warning?: string } {
    if (value == null || value === "") {
        return { outcome: "success" };
    }
    const text = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (text === "success" || text === "succeeded" || text === "ok") {
        return { outcome: "success" };
    }
    if (text === "cancel" || text === "canceled" || text === "cancelled" || text === "interrupted") {
        return { outcome: "cancel" };
    }
    if (text === "failure" || text === "failed" || text === "error") {
        return { outcome: "failure" };
    }
    const shown = typeof value === "string" ? value : typeof value;
    return {
        outcome: "success",
        warning: `Unrecognized channel store orderResult "${shown}"; using success.`,
    };
}

function normalizeProduct(entry: unknown): ChannelStoreProduct | undefined {
    if (entry == null || typeof entry !== "object") {
        return undefined;
    }
    const record = entry as Record<string, unknown>;
    const code = asText(record.code);
    if (code === "") {
        return undefined;
    }
    const name = asText(record.name) || code;
    const price = asText(record.price) || asText(record.cost) || "$0.00";
    const productType = asText(record.productType) || "Consumable";
    return { code, name, price, productType };
}

function normalizePurchase(entry: unknown): ChannelStorePurchase | undefined {
    const product = normalizeProduct(entry);
    if (!product || entry == null || typeof entry !== "object") {
        return undefined;
    }
    const record = entry as Record<string, unknown>;
    const qtyValue = record.qty;
    const qty = typeof qtyValue === "number" && Number.isFinite(qtyValue) ? Math.trunc(qtyValue) : 1;
    const statusText = asText(record.status);
    const status = statusText === "" ? "Valid" : statusText;
    const purchaseId = asText(record.purchaseId) || genHexAddress();
    const purchaseDate = asText(record.purchaseDate) || new Date().toISOString();
    return { ...product, qty: qty > 0 ? qty : 1, purchaseId, purchaseDate, status };
}

function catalogRecord(product: ChannelStoreProduct): ChannelStoreRecord {
    return {
        code: product.code,
        name: product.name,
        description: product.name,
        cost: product.price,
        productType: product.productType,
        qty: 1,
        freeTrialQuantity: 0,
        freeTrialType: "",
        status: "approved for sale",
    };
}

function purchaseRecord(purchase: ChannelStorePurchase): ChannelStoreRecord {
    return {
        code: purchase.code,
        name: purchase.name,
        description: purchase.name,
        cost: purchase.price,
        productType: purchase.productType,
        qty: purchase.qty ?? 1,
        purchaseId: purchase.purchaseId ?? "",
        purchaseDate: purchase.purchaseDate ?? "",
        status: purchase.status ?? "Valid",
        inDunning: "false",
    };
}

function isExpired(status: string | undefined): boolean {
    return (status ?? "Valid").trim().toLowerCase() === "invalid";
}

function asText(value: unknown): string {
    if (typeof value === "string") {
        return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
    }
    return "";
}

function readChannelStoreFile(filePath: string): { mock?: ChannelStoreMock; warning?: string } {
    /// #if !BROWSER
    try {
        const fullPath = path.resolve(filePath);
        const text = fs.readFileSync(fullPath, "utf8");
        const parsed: unknown = JSON.parse(text);
        if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
            return { warning: `Channel store file ${filePath} is not a JSON object; using an empty catalog.` };
        }
        return { mock: parsed as ChannelStoreMock };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { warning: `Unable to load channel store file ${filePath}: ${message}` };
    }
    /// #else
    return {
        warning: `Channel store path "${filePath}" cannot be read in the browser; pass the mock object instead.`,
    };
    /// #endif
}
