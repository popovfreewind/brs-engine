const brs = require("../../../packages/node/bin/brs.node");
const { Interpreter } = brs;
const { BrsString, BrsInvalid, RoXMLElement, ValueKind } = brs.types;

brs.registerCallback(() => {}); // register a callback to avoid display errors

describe("RoXMLElement", () => {
    let xmlParser;
    let interpreter;

    beforeEach(() => {
        xmlParser = new RoXMLElement();
        interpreter = new Interpreter();
    });

    describe("test methods for object with successful parsed xml", () => {
        beforeEach(() => {
            let parse = xmlParser.getMethod("parse");
            parse.call(interpreter, new BrsString(getXmlString()));
        });

        it("getName", () => {
            let getName = xmlParser.getMethod("getName");
            expect(getName.call(interpreter)).toEqual(new BrsString("tag1"));
        });

        it("getNamedElementsCi", () => {
            let getNamedElementsCi = xmlParser.getMethod("getNamedElementsCi");
            expect(getNamedElementsCi.call(interpreter, new BrsString("any")).getElements()).toEqual([]);

            let children = getNamedElementsCi.call(interpreter, new BrsString("CHiLd1"));
            expect(children.getElements().length).toEqual(2);

            let getName = children.getElements()[0].getMethod("getName");
            expect(getName.call(interpreter)).toEqual(new BrsString("Child1"));

            getName = children.getElements()[1].getMethod("getName");
            expect(getName.call(interpreter)).toEqual(new BrsString("CHILD1"));
        });

        it("getAttributes", () => {
            let getAttributes = xmlParser.getMethod("getAttributes");
            expect(getAttributes.call(interpreter).elements).not.toEqual(new Map());
            expect(getAttributes.call(interpreter).elements).toEqual(
                new Map([
                    ["id", new BrsString("someId")],
                    ["attr1", new BrsString("0")],
                ])
            );
        });
    });

    describe.each([
        ["test methods for object with no parsed xml", () => {}],
        [
            "test methods for object with failed parsing of xml",
            () => {
                let parse = xmlParser.getMethod("parse");
                parse.call(interpreter, new BrsString('>bad_tag id="12" <  some text >/bad_tag<'));
            },
        ],
    ])("%s", (name, tryParse) => {
        beforeEach(() => {
            tryParse();
        });

        it("getName", () => {
            let getName = xmlParser.getMethod("getName");
            expect(getName).toBeTruthy();
            expect(getName.call(interpreter)).toEqual(new BrsString(""));
        });

        it("getNamedElementsCi", () => {
            let getNamedElementsCi = xmlParser.getMethod("getNamedElementsCi");
            expect(getNamedElementsCi).toBeTruthy();
            expect(getNamedElementsCi.call(interpreter, new BrsString("any")).getElements()).toEqual([]);
        });

        it("getAttributes", () => {
            let getAttributes = xmlParser.getMethod("getAttributes");
            expect(getAttributes).toBeTruthy();
            expect(getAttributes.call(interpreter).elements).toEqual(new Map());
        });
    });

    describe("test parse method with different xml strings", () => {
        test.each([
            ["<tag>some text<tag>", false],
            ["<tag>some text</tag>", true],
            ["<tag>some text <child1> child's text </child1> </tag>", true],
            [getXmlString(), true],
            ['>bad_tag id="12" <  some text >/bad_tag<', false],
            ["", false],
        ])("test parse with string %s", (xmlString, expected) => {
            let parse = xmlParser.getMethod("parse");
            expect(parse.call(interpreter, new BrsString(xmlString)).value).toBe(expected);
        });
    });
    describe("child nodes, elements, and text", () => {
        function parse(xml) {
            let element = new RoXMLElement();
            let ok = element.getMethod("parse").call(interpreter, new BrsString(xml));
            expect(ok.value).toBe(true);
            return element;
        }

        function call(element, name, ...args) {
            return element.getMethod(name).call(interpreter, ...args);
        }

        // One entry per GetChildNodes item: element name, or the exact text.
        function summarize(list) {
            expect(list).not.toBe(BrsInvalid.Instance);
            return list.elements.map((node) => {
                if (node.kind === ValueKind.String) {
                    return node.value;
                }
                // Every remaining item is an element, so element methods are safe to call.
                return call(node, "getName").value;
            });
        }

        it("omits indentation and newlines between elements", () => {
            let catalog = parse(`<catalog>
    <book id="1">
        <title>River</title>
        <author>Ada</author>
    </book>
    <book id="2">
        <title>Hill</title>
    </book>
</catalog>`);

            let books = call(catalog, "getChildNodes");
            expect(summarize(books)).toEqual(["book", "book"]);
            for (let book of books.elements) {
                expect(call(book, "getName")).toEqual(new BrsString("book"));
            }

            let first = books.elements[0];
            expect(summarize(call(first, "getChildNodes"))).toEqual(["title", "author"]);
            expect(call(call(first, "getChildElements").getElements()[0], "getText")).toEqual(new BrsString("River"));

            // Same elements from the element-only APIs, despite the formatting text.
            expect(
                call(catalog, "getChildElements")
                    .getElements()
                    .map((node) => call(node, "getName").value)
            ).toEqual(["book", "book"]);
            expect(call(catalog, "getNamedElements", new BrsString("book")).getElements()).toHaveLength(2);
            expect(call(catalog, "getNamedElements", new BrsString("Book")).getElements()).toEqual([]);
            expect(call(catalog, "getNamedElementsCi", new BrsString("BOOK")).getElements()).toHaveLength(2);

            // No significant text at this level, so the body is the child elements.
            expect(call(catalog, "getText")).toEqual(new BrsString(""));
            expect(call(catalog, "getBody").getElements()).toHaveLength(2);
        });

        it("keeps text that shares a node with surrounding whitespace", () => {
            let label = parse("<label>  padded  </label>");
            expect(call(label, "getText")).toEqual(new BrsString("  padded  "));
            expect(summarize(call(label, "getChildNodes"))).toEqual(["  padded  "]);
            expect(call(label, "getBody")).toEqual(new BrsString("  padded  "));
            expect(call(label, "getChildElements")).toBe(BrsInvalid.Instance);

            let verse = parse("<verse>one\ntwo</verse>");
            expect(call(verse, "getText")).toEqual(new BrsString("one\ntwo"));
            expect(summarize(call(verse, "getChildNodes"))).toEqual(["one\ntwo"]);

            // Newlines around a word belong to that word's text node and stay with it.
            let title = parse("<title>\n    Hello\n</title>");
            expect(call(title, "getText")).toEqual(new BrsString("\n    Hello\n"));
            expect(summarize(call(title, "getChildNodes"))).toEqual(["\n    Hello\n"]);
        });

        it("returns mixed content in order and still finds the elements", () => {
            let paragraph = parse("<paragraph>See the <em>bold</em> word.</paragraph>");
            expect(summarize(call(paragraph, "getChildNodes"))).toEqual(["See the ", "em", " word."]);
            // The two text nodes are concatenated, including the space each one carries.
            expect(call(paragraph, "getText")).toEqual(new BrsString("See the  word."));
            expect(call(call(paragraph, "getChildElements").getElements()[0], "getText")).toEqual(
                new BrsString("bold")
            );
            // A child element makes GetBody the element list; the loose text stays on GetText.
            let body = call(paragraph, "getBody");
            expect(body.getElements()).toHaveLength(1);
            expect(call(body.getElements()[0], "getName")).toEqual(new BrsString("em"));
            expect(call(paragraph, "getNamedElements", new BrsString("em")).getElements()).toHaveLength(1);

            let section = parse(`<section>
    Intro text
    <child>Inner</child>
    Outro text
</section>`);
            expect(summarize(call(section, "getChildNodes"))).toEqual([
                "\n    Intro text\n    ",
                "child",
                "\n    Outro text\n",
            ]);
            expect(call(section, "getText")).toEqual(new BrsString("\n    Intro text\n    \n    Outro text\n"));
            expect(call(call(section, "getNamedElements", new BrsString("child")).getElements()[0], "getText")).toEqual(
                new BrsString("Inner")
            );
            expect(call(section, "getChildElements").getElements()).toHaveLength(1);
        });

        it("treats a whitespace-only body as empty and ignores formatting between tags", () => {
            let gap = parse("<gap>   \n\t</gap>");
            expect(call(gap, "getChildNodes")).toBe(BrsInvalid.Instance);
            expect(call(gap, "getChildElements")).toBe(BrsInvalid.Instance);
            expect(call(gap, "getText")).toEqual(new BrsString(""));
            expect(call(gap, "getBody")).toBe(BrsInvalid.Instance);

            let root = parse("<root>\r\n\t<item>Ok</item>\r\n</root>");
            expect(summarize(call(root, "getChildNodes"))).toEqual(["item"]);
            expect(call(root, "getText")).toEqual(new BrsString(""));
            expect(call(call(root, "getChildElements").getElements()[0], "getText")).toEqual(new BrsString("Ok"));

            // A non-breaking space is not XML whitespace, so it is real text.
            let nbsp = parse("<root>&#160;</root>");
            expect(call(nbsp, "getText")).toEqual(new BrsString("\u00A0"));
            expect(summarize(call(nbsp, "getChildNodes"))).toEqual(["\u00A0"]);
        });

        it("keeps CDATA text, including whitespace, and skips comments", () => {
            let raw = parse("<wrap><![CDATA[  raw  ]]></wrap>");
            expect(call(raw, "getText")).toEqual(new BrsString("  raw  "));
            expect(summarize(call(raw, "getChildNodes"))).toEqual(["  raw  "]);

            let blank = parse("<wrap><![CDATA[   ]]></wrap>");
            expect(call(blank, "getText")).toEqual(new BrsString("   "));
            expect(summarize(call(blank, "getChildNodes"))).toEqual(["   "]);
            expect(call(blank, "getBody")).toEqual(new BrsString("   "));

            let noted = parse(`<root>
  <!-- note -->
  <child>Yes</child>
</root>`);
            expect(summarize(call(noted, "getChildNodes"))).toEqual(["child"]);
            expect(call(call(noted, "getChildNodes").elements[0], "getText")).toEqual(new BrsString("Yes"));
        });
    });

    it.todo("add tests for all remaining methods");
});

function getXmlString() {
    return '<tag1 id="someId" attr1="0"> <Child1 id="id1"></Child1> <CHILD1 id="id2"></CHILD1> </tag1>';
}
