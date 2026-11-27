const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const brs = require("../../../packages/node/bin/brs.node");
const { Interpreter, BrsDevice, DataType, KeyArraySpots, RemoteType, configureChannelStore } = brs;
const { BrsString, RoChannelStore, RoMessagePort, toAssociativeArray } = brs.types;

/** Select on a Roku remote. ECP `keypress/Select` is this code, down then up. */
const SELECT = 6;

function newSharedArray() {
    const length = brs.DataBufferIndex + brs.DataBufferSize;
    const array = new Int32Array(new SharedArrayBuffer(length * Int32Array.BYTES_PER_ELEMENT));
    array.fill(-1);
    return array;
}

/** Writes one key event the way the ECP/browser control path does. */
function writeKeySlot(array, slot, code, mod) {
    const idx = slot * KeyArraySpots;
    Atomics.store(array, DataType.RID + idx, RemoteType.ECP);
    Atomics.store(array, DataType.MOD + idx, mod);
    Atomics.store(array, DataType.KEY + idx, code + mod);
}

function textOf(aa, name) {
    return aa.get(new BrsString(name)).getValue();
}

const testCatalog = {
    orderResult: "success",
    products: [
        { code: "test_product_1", name: "Test Product", price: "$0.99", productType: "Consumable" },
        { code: "test_product_2", name: "Test Subscription", price: "$4.99", productType: "MonthlySub" },
    ],
    purchases: [
        {
            code: "test_product_2",
            name: "Test Subscription",
            price: "$4.99",
            productType: "MonthlySub",
            qty: 1,
            status: "Valid",
        },
        {
            code: "test_product_1",
            name: "Test Product",
            price: "$0.99",
            productType: "Consumable",
            qty: 1,
            status: "Invalid",
        },
    ],
};

describe("roChannelStore session mock", () => {
    let interpreter;
    let sharedArray;

    beforeEach(() => {
        interpreter = new Interpreter();
        configureChannelStore(undefined);
        sharedArray = newSharedArray();
        BrsDevice.setSharedArray(sharedArray);
        BrsDevice.resetKeysBuffer();
        BrsDevice.singleKeyEvents = true;
        BrsDevice.multiControllers = false;
    });

    function storeWithPort() {
        const store = new RoChannelStore();
        const port = new RoMessagePort();
        store.getMethod("setMessagePort").call(interpreter, port);
        return { store, port };
    }

    function setOrder(store, code, qty = 1) {
        store.setNewOrder([toAssociativeArray({ code, qty })]);
    }

    function readEvent(port) {
        return port.getMethod("getMessage").call(interpreter);
    }

    test("with no mock file, catalog and purchase queries succeed with an empty list", () => {
        const { store, port } = storeWithPort();
        store.getMethod("getCatalog").call(interpreter);
        const catalog = readEvent(port);
        expect(catalog.getMethod("getStatus").call(interpreter).getValue()).toBe(1);
        expect(catalog.getMethod("getStatusMessage").call(interpreter).getValue()).toBe("Success");
        expect(catalog.getMethod("isRequestSucceeded").call(interpreter).toBoolean()).toBe(true);
        expect(catalog.getMethod("isRequestFailed").call(interpreter).toBoolean()).toBe(false);
        expect(catalog.getMethod("getResponse").call(interpreter).getElements()).toHaveLength(0);

        store.getMethod("getPurchases").call(interpreter);
        const purchases = readEvent(port);
        expect(purchases.getMethod("getStatus").call(interpreter).getValue()).toBe(1);
        expect(purchases.getMethod("getResponse").call(interpreter).getElements()).toHaveLength(0);
    });

    test("serves catalog, active purchases and expired purchases from the mock", () => {
        configureChannelStore(testCatalog);
        const { store, port } = storeWithPort();

        store.getMethod("getCatalog").call(interpreter);
        const catalog = readEvent(port).getMethod("getResponse").call(interpreter).getElements();
        expect(catalog.map((item) => textOf(item, "code"))).toEqual(["test_product_1", "test_product_2"]);
        expect(textOf(catalog[0], "cost")).toBe("$0.99");
        expect(textOf(catalog[0], "name")).toBe("Test Product");
        expect(textOf(catalog[0], "productType")).toBe("Consumable");

        store.getMethod("getStoreCatalog").call(interpreter);
        const storeCatalog = readEvent(port).getMethod("getResponse").call(interpreter).getElements();
        expect(storeCatalog.map((item) => textOf(item, "code"))).toEqual(["test_product_1", "test_product_2"]);

        store.getMethod("getPurchases").call(interpreter);
        const active = readEvent(port).getMethod("getResponse").call(interpreter).getElements();
        expect(active.map((item) => textOf(item, "code"))).toEqual(["test_product_2"]);
        expect(textOf(active[0], "status")).toBe("Valid");

        store.getMethod("getAllPurchases").call(interpreter);
        const all = readEvent(port).getMethod("getResponse").call(interpreter).getElements();
        expect(all.map((item) => `${textOf(item, "code")} ${textOf(item, "status")}`)).toEqual([
            "test_product_2 Valid",
            "test_product_1 Invalid",
        ]);
    });

    test("a successful DoOrder adds the product to the session purchase list", () => {
        configureChannelStore(testCatalog);
        const { store, port } = storeWithPort();
        setOrder(store, "test_product_1");
        const approved = store.getMethod("doOrder").call(interpreter);
        expect(approved.toBoolean()).toBe(true);

        const event = readEvent(port);
        expect(event.getMethod("getStatus").call(interpreter).getValue()).toBe(1);
        expect(event.getMethod("isRequestSucceeded").call(interpreter).toBoolean()).toBe(true);
        const purchased = event.getMethod("getResponse").call(interpreter).getElements();
        expect(purchased).toHaveLength(1);
        expect(textOf(purchased[0], "code")).toBe("test_product_1");
        expect(textOf(purchased[0], "amount")).toBe("$0.99");
        expect(textOf(purchased[0], "total")).toBe("$0.99");
        expect(purchased[0].get(new BrsString("qty")).getValue()).toBe(1);
        expect(textOf(purchased[0], "purchaseId")).not.toBe("");

        // The cart is consumed, and a second store in this session sees the new purchase.
        expect(store.getOrderItems()).toHaveLength(0);
        const other = new RoChannelStore();
        const status = { code: 0, message: "" };
        const owned = other.getProductData("GetPurchases", status).map((item) => textOf(item, "code"));
        expect(status).toEqual({ code: 1, message: "Success" });
        expect(owned).toEqual(["test_product_2", "test_product_1"]);
    });

    test("ClearOrder leaves nothing to buy", () => {
        configureChannelStore(testCatalog);
        const { store, port } = storeWithPort();
        setOrder(store, "test_product_1");
        store.getMethod("clearOrder").call(interpreter);
        const approved = store.getMethod("doOrder").call(interpreter);
        expect(approved.toBoolean()).toBe(false);
        const event = readEvent(port);
        expect(event.getMethod("getStatus").call(interpreter).getValue()).toBe(-4);
        expect(event.getMethod("getStatusMessage").call(interpreter).getValue()).toBe("Invalid request");
        expect(event.getMethod("isRequestFailed").call(interpreter).toBoolean()).toBe(true);
    });

    test.each([
        ["cancel", 2, "Interrupted", "isRequestInterrupted"],
        ["failure", -3, "Unknown Error", "isRequestFailed"],
    ])("orderResult %s reports status %i and does not record a purchase", (orderResult, code, message, predicate) => {
        configureChannelStore({ ...testCatalog, orderResult });
        const { store, port } = storeWithPort();
        setOrder(store, "test_product_1");
        expect(store.getMethod("doOrder").call(interpreter).toBoolean()).toBe(false);
        const event = readEvent(port);
        expect(event.getMethod("getStatus").call(interpreter).getValue()).toBe(code);
        expect(event.getMethod("getStatusMessage").call(interpreter).getValue()).toBe(message);
        expect(event.getMethod(predicate).call(interpreter).toBoolean()).toBe(true);
        expect(event.getMethod("getResponse").call(interpreter).getElements()).toHaveLength(0);
        // The cart is kept so the channel can retry, but nothing was purchased.
        expect(store.getOrderItems()).toHaveLength(1);
        const status = { code: 0, message: "" };
        expect(store.getProductData("GetPurchases", status).map((item) => textOf(item, "code"))).toEqual([
            "test_product_2",
        ]);
    });

    test("a canceled order does not swallow the next Select press", () => {
        // The channel opens DoOrder from the Select press on a focused button, so that key is
        // still down when the order completes. The next ECP Select is the same key code. While
        // the first press stays "held", updateKeysBuffer drops it and the button never fires.
        configureChannelStore({ ...testCatalog, orderResult: "cancel" });
        const { store } = storeWithPort();
        setOrder(store, "test_product_1");
        BrsDevice.lastKey = SELECT;
        BrsDevice.lastMod = 0;
        writeKeySlot(sharedArray, 0, SELECT, 0);

        store.getMethod("doOrder").call(interpreter);

        expect(BrsDevice.lastKey).toBe(-1);
        expect(BrsDevice.lastMod).toBe(-1);
        expect(BrsDevice.updateKeysBuffer()).toEqual({ remote: "ECP:0", key: SELECT, mod: 0 });
    });

    test.each(["success", "cancel", "failure"])(
        "an ECP Select sent after orderResult %s is delivered as a press",
        (orderResult) => {
            // The Select that opened the order is still down. Its key-up arrives after the
            // order (ECP sends it 300ms later) and must not re-hold the key. The next
            // keypress — down and up both waiting, the way the host writes them when the
            // interpreter has been busy — has to come through as a press.
            configureChannelStore({ ...testCatalog, orderResult });
            const { store } = storeWithPort();
            setOrder(store, "test_product_1");
            BrsDevice.lastKey = SELECT;
            BrsDevice.lastMod = 0;
            store.getMethod("doOrder").call(interpreter);

            writeKeySlot(sharedArray, 0, SELECT, 100);
            expect(BrsDevice.updateKeysBuffer()).toBeUndefined();
            expect(BrsDevice.lastMod).toBe(-1);

            writeKeySlot(sharedArray, 0, SELECT, 0);
            writeKeySlot(sharedArray, 1, SELECT, 100);
            expect(BrsDevice.updateKeysBuffer()).toEqual({ remote: "ECP:0", key: SELECT, mod: 0 });
        }
    );

    test.each(["success", "cancel", "failure"])(
        "a held Select after orderResult %s does not swallow the next ECP Select",
        (orderResult) => {
            // resetKeysBuffer() runs on the thread that finished the order. The thread that
            // reads ECP keys can still see the opening Select as down (its key-up never
            // arrived). The next keypress is the same code: down, then up.
            configureChannelStore({ ...testCatalog, orderResult });
            const { store } = storeWithPort();
            setOrder(store, "test_product_1");
            store.getMethod("doOrder").call(interpreter);
            BrsDevice.lastKey = SELECT;
            BrsDevice.lastMod = 0;
            writeKeySlot(sharedArray, 0, SELECT, 0);
            writeKeySlot(sharedArray, 1, SELECT, 100);

            expect(BrsDevice.updateKeysBuffer()).toEqual({ remote: "ECP:0", key: SELECT, mod: 0 });
            // The queued release leaves the key up, so another Select is a press too.
            BrsDevice.updateKeysBuffer();
            BrsDevice.updateKeysBuffer();
            writeKeySlot(sharedArray, 0, SELECT, 0);
            writeKeySlot(sharedArray, 1, SELECT, 100);
            expect(BrsDevice.updateKeysBuffer()).toEqual({ remote: "ECP:0", key: SELECT, mod: 0 });
        }
    );

    test("a failed order releases a held Select before the next press", () => {
        configureChannelStore({ ...testCatalog, orderResult: "failure" });
        const { store } = storeWithPort();
        setOrder(store, "test_product_1");
        BrsDevice.lastKey = SELECT;
        BrsDevice.lastMod = 0;

        store.getMethod("doOrder").call(interpreter);

        // The opening Select's key-up arrives after the order and must not re-hold the key.
        writeKeySlot(sharedArray, 0, SELECT, 100);
        expect(BrsDevice.updateKeysBuffer()).toBeUndefined();
        expect(BrsDevice.lastMod).toBe(-1);

        writeKeySlot(sharedArray, 0, SELECT, 0);
        expect(BrsDevice.updateKeysBuffer()).toEqual({ remote: "ECP:0", key: SELECT, mod: 0 });
    });

    test("fakeServer(true) still reads the csfake XML path", () => {
        configureChannelStore(testCatalog);
        const store = new RoChannelStore();
        store.setFakeServer(true);
        const status = { code: -4, message: "Empty List" };
        const catalog = store.getProductData("GetCatalog", status);
        expect(status).toEqual({ code: 1, message: "Items Received" });
        expect(catalog).toHaveLength(0);
    });

    test("a filesystem path loads the same mock", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brs-channel-store-"));
        const file = path.join(dir, "store.json");
        fs.writeFileSync(
            file,
            JSON.stringify({
                products: [{ code: "test_product_1", name: "Test Product", price: "$0.99", productType: "Consumable" }],
            })
        );
        expect(configureChannelStore(file)).toBeUndefined();
        const status = { code: 0, message: "" };
        const catalog = new RoChannelStore().getProductData("GetCatalog", status);
        expect(textOf(catalog[0], "code")).toBe("test_product_1");
        expect(textOf(catalog[0], "cost")).toBe("$0.99");
    });

    test("an unknown orderResult warns and falls back to success", () => {
        expect(configureChannelStore({ orderResult: "nope" })).toMatch(/Unrecognized channel store orderResult/);
    });
});
