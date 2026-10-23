import { describe, it, expect } from "vitest";
import { stripXml, stripRichText } from "../src/utils/strip-markup.js";

describe("stripXml", () => {
  it("removes HTML/XML tags", () => {
    expect(stripXml("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });

  it("decodes HTML entities", () => {
    expect(stripXml("faith &amp; grace &lt;3&gt;")).toBe("faith & grace <3>");
  });

  it("normalizes whitespace", () => {
    expect(stripXml("hello   \n  world")).toBe("hello world");
  });

  it("returns null for null input", () => {
    expect(stripXml(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(stripXml("")).toBeNull();
  });
});

describe("stripRichText", () => {
  it("extracts text from Logos XAML Run elements", () => {
    const xaml = '<Paragraph><Run FontSize="12" Text="Grace alone"/></Paragraph>';
    expect(stripRichText(xaml)).toBe("Grace alone");
  });

  it("joins multiple Run elements with spaces", () => {
    const xaml = '<Paragraph><Run Text="Hello"/><Run Text="world"/></Paragraph>';
    expect(stripRichText(xaml)).toBe("Hello world");
  });

  it("adds newlines between paragraphs", () => {
    const xaml = '<Paragraph><Run Text="Line one"/></Paragraph><Paragraph><Run Text="Line two"/></Paragraph>';
    expect(stripRichText(xaml)).toBe("Line one\nLine two");
  });

  it("falls back to stripXml for non-XAML content", () => {
    expect(stripRichText("<p>Simple HTML</p>")).toBe("Simple HTML");
  });

  it("returns null for null input", () => {
    expect(stripRichText(null)).toBeNull();
  });

  it("returns null for whitespace-only result", () => {
    const xaml = '<Paragraph><Run Text="   "/></Paragraph>';
    expect(stripRichText(xaml)).toBeNull();
  });

  it("handles Text attributes with single quotes", () => {
    const xaml = "<Paragraph><Run Text='Grace alone'/></Paragraph>";
    expect(stripRichText(xaml)).toBe("Grace alone");
  });
});
