import { StarterKit } from "@tiptap/starter-kit";
import { TextAlign } from "@tiptap/extension-text-align";
import { Superscript } from "@tiptap/extension-superscript";
import SubScript from "@tiptap/extension-subscript";
import { Typography } from "@tiptap/extension-typography";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { Youtube } from "@tiptap/extension-youtube";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import { Code } from "./code";
import { Heading } from "./heading/heading";
import { UniqueID, UNIQUE_ID_TYPES } from "./unique-id";
import { Comment } from "./comment/comment";
import { Indent } from "./indent";
import { LinkExtension } from "./link";
import { Highlight } from "./highlight";
import { Spoiler } from "./spoiler/spoiler";
import { TrailingNode } from "./trailing-node";
import { MathInline, MathBlock } from "./math";
import { Details, DetailsContent, DetailsSummary } from "./details";
import { CustomTable, TableCell, TableRow, TableHeader } from "./table";
import { TiptapImage } from "./image";
import { TiptapVideo } from "./video";
import { TiptapAudio } from "./audio";
import { TiptapPdf } from "./pdf";
import { PageBreak } from "./page-break";
import { Callout } from "./callout";
import { Attachment } from "./attachment";
import { CustomCodeBlock } from "./custom-code-block";
import { Drawio } from "./drawio";
import { Excalidraw } from "./excalidraw";
import { Embed } from "./embed";
import { HtmlEmbed } from "./html-embed/html-embed";
import { Mention } from "./mention";
import { Subpages } from "./subpages";
import { Columns, Column } from "./columns";
import { Status } from "./status";
import { TransclusionSource, TransclusionReference } from "./transclusion";
import {
  FootnoteReference,
  FootnotesList,
  FootnoteDefinition,
} from "./footnote";
import { PageEmbed } from "./page-embed";

// The Docmost document schema: the server's write path and the markdown
// converter both build their schema from this list.
export const documentExtensions = [
  StarterKit.configure({
    codeBlock: false,
    link: false,
    trailingNode: false,
    heading: false,
    // #515: StarterKit's stock `code` mark ships `excludes: "_"`, which strips
    // every co-occurring inline mark on the HTML -> PM parse (htmlToJson) and on
    // editor transactions. Use the shared Docmost `Code` (excludes: "code") instead,
    // so bold/italic/… around inline code survive import and editing.
    code: false,
  }),
  Code,
  Heading,
  UniqueID.configure({
    types: UNIQUE_ID_TYPES,
  }),
  Comment,
  TextAlign.configure({ types: ["heading", "paragraph"] }),
  Indent,
  TaskList,
  TaskItem.configure({
    nested: true,
  }),
  LinkExtension,
  Superscript,
  SubScript,
  Highlight,
  Spoiler,
  Typography,
  TrailingNode,
  TextStyle,
  Color,
  MathInline,
  MathBlock,
  Details,
  DetailsContent,
  DetailsSummary,
  CustomTable,
  TableCell,
  TableRow,
  TableHeader,
  Youtube,
  TiptapImage,
  TiptapVideo,
  TiptapAudio,
  TiptapPdf,
  PageBreak,
  Callout,
  Attachment,
  CustomCodeBlock,
  Drawio,
  Excalidraw,
  Embed,
  // Registered so the node survives schema parsing/serialization. Any member
  // can insert it when the workspace `htmlEmbed` toggle is on; with the toggle
  // off, `stripHtmlEmbedNodes` removes it from anonymous public-share reads.
  HtmlEmbed,
  Mention,
  Subpages,
  Columns,
  Column,
  Status,
  TransclusionSource,
  TransclusionReference,
  FootnoteReference,
  FootnotesList,
  FootnoteDefinition,
  PageEmbed,
] as any;
