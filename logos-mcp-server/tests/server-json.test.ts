import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { makeFixtureDirs, createDb, cleanupFixtureDirs, type FixtureDirs } from "./helpers/fixtures.js";
import { NOTES_SCHEMA_LOGOS54, CATALOG_SCHEMA, CLIPPINGS_SCHEMA, WORKFLOWS_SCHEMA, rawBlobHex } from "./helpers/schemas.js";
import { startServer, callTool } from "./helpers/server.js";

// Every SQLite/catalog read tool (design doc 2.5).
const READ_TOOLS = [
  "get_user_notes",
  "get_user_highlights",
  "get_clippings",
  "get_favorites",
  "get_reading_progress",
  "get_study_workflows",
  "get_library_catalog",
  "get_resource_types",
  "get_resource_reading_progress",
  "get_reading_history",
  "get_passage_lists",
  "find_passage_resources",
];

describe("JSON output", () => {
  let dirs: FixtureDirs;
  let client: Client;

  beforeAll(async () => {
    dirs = makeFixtureDirs();
    createDb(
      join(dirs.dataDir, "NotesToolManager", "notestool.db"),
      `${NOTES_SCHEMA_LOGOS54}
       INSERT INTO NoteStyles (NoteStyleId, Name) VALUES (1, 'none'), (2, 'custom:YellowHighlighter');
       INSERT INTO ResourceIds (ResourceIdId, ResourceId) VALUES (1, 'LLS:NIVAC66RO');
       INSERT INTO Notes (NoteId, ExternalId, CreatedDate, ModifiedDate, Kind, ContentRichText, NoteStyleId, AnchorsJson, AnchorResourceIdId, TagsJson, NotebookExternalId) VALUES
         (1, 'n1', '2021-01-14T12:04:37Z', '2021-01-14T12:04:37Z', 0, '<Paragraph><Run Text="Aeneas healed"/></Paragraph>', 1, '[]', NULL, '[]', ''),
         (2, 'h1', '2023-05-24T01:15:39Z', '2023-05-24T01:15:39Z', 1, NULL, 2, '[]', 1, NULL, '');
       INSERT INTO NoteAnchorFacetReferences (NoteId, AnchorIndex, DataTypeId, BibleBook, SortKey, Reference) VALUES
         (1, 0, 1, 65, x'00', 'bible.65.9.35'), (2, 0, 1, 66, x'00', 'bible.66.1.8-66.1.15');`
    );
    createDb(
      join(dirs.catalogDir, "LibraryCatalog", "catalog.db"),
      `${CATALOG_SCHEMA}
       INSERT INTO Records (ResourceId, Type, Title, UseCount) VALUES
         ('LLS:29.48.20', 'text.monograph.commentary.bible', 'The Gospel according to John', 4),
         ('LLS:LEB', 'text.monograph.bible', 'The Lexham English Bible', 19);`
    );
    createDb(
      join(dirs.dataDir, "Documents", "Clippings", "Clippings.db"),
      `${CLIPPINGS_SCHEMA}
       INSERT INTO ClippingsDocuments (RowId, Title, IsDeleted) VALUES (1, 'Invented collection', 0);
       INSERT INTO Clippings (RowId, ResourceId, CreatedDate, Title, Content, Notes, Tags, DocumentRowId) VALUES
         (1, 'LLS:29.48.20', '2024-01-02T03:04:05Z', ${rawBlobHex("Invented clip title")},
          ${rawBlobHex("Invented clip text for the terms test.")}, ${rawBlobHex("Invented note of my own")}, 'invented-tag', 1);`
    );
    createDb(
      join(dirs.dataDir, "Workflows", "Workflows.db"),
      `${WORKFLOWS_SCHEMA}
       INSERT INTO Templates (TemplateId, ExternalId, TemplateJson, Author, CreatedDate, IsDeleted) VALUES
         (1, 'invented-template', '{"title":"Invented Template Title","steps":[{"title":"Invented workflow step"}]}', NULL, '2024-01-02T03:04:05Z', 0);`
    );
    client = await startServer(dirs);
  }, 30_000);
  afterAll(async () => {
    await client.close();
    cleanupFixtureDirs(dirs);
  });

  it("offers format text|json on every read tool", async () => {
    const { tools } = await client.listTools();
    for (const name of READ_TOOLS) {
      const tool = tools.find((t) => t.name === name);
      const format = (tool?.inputSchema.properties as Record<string, { enum?: string[] }> | undefined)?.format;
      expect(format?.enum, name).toEqual(["text", "json"]);
    }
  });

  it("returns notes with readable and raw references", async () => {
    const { text } = await callTool(client, "get_user_notes", { format: "json" });
    const [note] = JSON.parse(text);
    expect(note).toMatchObject({ anchorReference: "Acts 9:35", anchorRawReferences: ["bible.65.9.35"], content: "Aeneas healed" });
  });

  it("returns highlights with references and dates", async () => {
    const { text } = await callTool(client, "get_user_highlights", { format: "json" });
    expect(JSON.parse(text)[0]).toMatchObject({
      reference: "Romans 1:8-15",
      rawReferences: ["bible.66.1.8-66.1.15"],
      syncDate: "2023-05-24T01:15:39Z",
    });
  });

  it("returns catalog resources with their type label", async () => {
    const { text } = await callTool(client, "get_library_catalog", { format: "json" });
    expect(JSON.parse(text)).toEqual([
      expect.objectContaining({ resourceId: "LLS:LEB", type: "text.monograph.bible", typeLabel: "Bible" }),
      expect.objectContaining({ resourceId: "LLS:29.48.20", typeLabel: "Commentary" }),
    ]);
  });

  it("returns an empty JSON array instead of an empty-result message", async () => {
    const { text } = await callTool(client, "get_user_notes", { format: "json", query: "nothing matches this" });
    expect(JSON.parse(text)).toEqual([]);
  });

  it("returns resource types as JSON", async () => {
    const { text } = await callTool(client, "get_resource_types", { format: "json" });
    const summary = JSON.parse(text);
    // Both types have one resource, so their order is not defined.
    expect(summary).toHaveLength(2);
    expect(summary).toEqual(expect.arrayContaining([
      { label: "Bible", rawType: "text.monograph.bible", count: 1 },
      { label: "Commentary", rawType: "text.monograph.commentary.bible", count: 1 },
    ]));
  });

  it("get_clippings returns titles and the user's notes, never the clipped text", async () => {
    const { text } = await callTool(client, "get_clippings");
    expect(text).toContain("Invented clip title");
    expect(text).toContain("Invented note of my own");
    expect(text).not.toContain("Invented clip text");
    const json = await callTool(client, "get_clippings", { format: "json" });
    expect(json.text).toContain("Invented note of my own");
    expect(json.text).not.toContain("Invented clip text");
    expect(json.text).not.toContain('"content"');
  });

  it("get_study_workflows returns template titles, not their steps", async () => {
    for (const format of ["text", "json"] as const) {
      const { text } = await callTool(client, "get_study_workflows", { format });
      expect(text, format).toContain("Invented Template Title");
      expect(text, format).not.toContain("Invented workflow step");
      expect(text, format).not.toContain("templateJson");
    }
  });
});
