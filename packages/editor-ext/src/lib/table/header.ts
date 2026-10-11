import { TableHeader as TiptapTableHeader } from "@tiptap/extension-table";

export const TableHeader = TiptapTableHeader.extend({
  name: "tableHeader",
  content:
    "(paragraph | heading | bulletList | orderedList | taskList | blockquote | callout | image | video | audio | subpages | attachment | mathBlock | details | codeBlock)+",

  addAttributes() {
    return {
      ...this.parent?.(),
      // Column alignment so GFM aligned tables (|:--|:-:|--:|) keep it through the
      // markdown converter and the server-side write path, which both build their
      // schema from this extension.
      align: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute("align") || element.style.textAlign || null,
        renderHTML: (attributes) =>
          attributes.align ? { align: attributes.align } : {},
      },
      backgroundColor: {
        default: null,
        parseHTML: (element) =>
          element.style.backgroundColor ||
          element.getAttribute("data-background-color") ||
          null,
        renderHTML: (attributes) => {
          if (!attributes.backgroundColor) {
            return {};
          }
          return {
            style: `background-color: ${attributes.backgroundColor}`,
            "data-background-color": attributes.backgroundColor,
          };
        },
      },
      backgroundColorName: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute("data-background-color-name") || null,
        renderHTML: (attributes) => {
          if (!attributes.backgroundColorName) {
            return {};
          }
          return {
            "data-background-color-name":
              attributes.backgroundColorName.toLowerCase(),
          };
        },
      },
    };
  },
});
