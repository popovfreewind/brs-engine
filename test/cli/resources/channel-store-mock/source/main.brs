sub Main()
    port = CreateObject("roMessagePort")
    store = CreateObject("roChannelStore")
    store.SetMessagePort(port)

    store.GetCatalog()
    printStatus("catalog", wait(1000, port))

    store.GetStoreCatalog()
    printStatus("storeCatalog", wait(1000, port))

    store.GetPurchases()
    printStatus("purchases", wait(1000, port))

    store.GetAllPurchases()
    printStatus("allPurchases", wait(1000, port))

    order = []
    order.push({ code: "test_product_1", qty: 1 })
    store.SetOrder(order)
    print "doOrder "; yesNo(store.DoOrder())
    printStatus("order", wait(1000, port))

    store.GetPurchases()
    printStatus("owned", wait(1000, port))

    store.ClearOrder()
    print "cleared "; yesNo(store.DoOrder())
    printStatus("empty", wait(1000, port))
end sub

sub printStatus(label as string, msg as object)
    print label; " "; msg.GetStatus().toStr(); " "; msg.GetStatusMessage()
    items = msg.GetResponse()
    if items = invalid then return
    for each item in items
        if label = "catalog" or label = "storeCatalog"
            print item.code; " "; item.name; " "; item.cost; " "; item.productType
        else if label = "order"
            print item.code; " "; item.amount; " "; item.total; " "; item.qty.toStr()
        else if item.status <> invalid
            print item.code; " "; item.cost; " "; item.status
        end if
    end for
end sub

function yesNo(value as boolean) as string
    if value then return "true"
    return "false"
end function
