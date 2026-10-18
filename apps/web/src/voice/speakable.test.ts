import { describe, expect, it } from "vite-plus/test";

import { createSpeechChunker, prepareSpeech } from "./speakable";

describe("prepareSpeech", () => {
  it("returns empty prose for empty and whitespace-only markdown", () => {
    expect(prepareSpeech("")).toEqual({ text: "", truncated: false });
    expect(prepareSpeech("  \n\n \t ")).toEqual({ text: "", truncated: false });
  });

  it("keeps heading text as a sentence and adds a missing period", () => {
    expect(prepareSpeech("# Release notes")).toEqual({ text: "Release notes.", truncated: false });
  });

  it("leaves heading punctuation that is already there alone", () => {
    expect(prepareSpeech("## What changed?").text).toBe("What changed?");
    expect(prepareSpeech("###### Ship it").text).toBe("Ship it.");
  });

  it("turns each item of a short list into its own sentence", () => {
    expect(prepareSpeech("- add cache\n- ship it\n* write tests").text).toBe(
      "add cache. ship it. write tests.",
    );
  });

  it("keeps ordered list markers out of the spoken text", () => {
    expect(prepareSpeech("1. first thing\n2. second thing").text).toBe(
      "first thing. second thing.",
    );
  });

  it("keeps a five item list because it is still short enough to read", () => {
    const prepared = prepareSpeech("- a\n- b\n- c\n- d\n- e");
    expect(prepared.truncated).toBe(false);
    expect(prepared.text).toBe("a. b. c. d. e.");
  });

  it("stops at a longer list and says so", () => {
    expect(prepareSpeech("Here is a summary.\n\n- a\n- b\n- c\n- d\n- e\n- f")).toEqual({
      text: "Here is a summary. Details are in the thread.",
      truncated: true,
    });
  });

  it("stops at a six item list even when nothing came before it", () => {
    expect(prepareSpeech("- a\n- b\n- c\n- d\n- e\n- f")).toEqual({
      text: "",
      truncated: true,
    });
  });

  it("stops at a fenced code block", () => {
    expect(prepareSpeech("Intro line.\n\n```ts\nconst x = 1;\n```")).toEqual({
      text: "Intro line. Details are in the thread.",
      truncated: true,
    });
  });

  it("stops at a code fence that never closes", () => {
    expect(prepareSpeech("Intro line.\n\n```\nconst x = 1;").text).toBe(
      "Intro line. Details are in the thread.",
    );
    expect(prepareSpeech("Intro line.\n\n~~~").truncated).toBe(true);
  });

  it("stops at a code fence that opens the reply", () => {
    expect(prepareSpeech("```sh\npnpm test\n```")).toEqual({ text: "", truncated: true });
  });

  it("stops at a table", () => {
    expect(prepareSpeech("Numbers look good.\n\n| a | b |\n| - | - |")).toEqual({
      text: "Numbers look good. Details are in the thread.",
      truncated: true,
    });
  });

  it("speaks a link by its label", () => {
    expect(prepareSpeech("See [the docs](https://example.com/a) for more").text).toBe(
      "See the docs for more",
    );
  });

  it("drops images entirely", () => {
    expect(prepareSpeech("Here ![diagram](https://example.com/y.png) is the change").text).toBe(
      "Here is the change",
    );
  });

  it("replaces a bare url with a link", () => {
    expect(prepareSpeech("Read https://example.com/docs now").text).toBe("Read a link now");
    expect(prepareSpeech("Read https://example.com/docs. Then stop").text).toBe(
      "Read a link. Then stop",
    );
  });

  it("speaks only the last path segment of inline code", () => {
    expect(prepareSpeech("Open `src/state/npmRelease.ts` please").text).toBe(
      "Open npmRelease dot ts please",
    );
  });

  it("speaks dots inside inline code as dot", () => {
    expect(prepareSpeech("Run `pnpm-lock.yaml` first").text).toBe("Run pnpm-lock dot yaml first");
  });

  it("speaks a long hex inline code token as a hash", () => {
    expect(prepareSpeech("Fixed in `64a4472d3` today").text).toBe("Fixed in a hash today");
  });

  it("speaks a bare commit id as a hash", () => {
    expect(prepareSpeech("Commit 64a4472d3d0 fixed it").text).toBe("Commit a hash fixed it");
  });

  it("keeps hex-looking words that carry no digit", () => {
    expect(prepareSpeech("the deadbeef token").text).toBe("the deadbeef token");
  });

  it("strips emphasis without touching underscores inside identifiers", () => {
    expect(
      prepareSpeech("Use **bold** and *italic* and ~~struck~~ for snake_case_value").text,
    ).toBe("Use bold and italic and struck for snake_case_value");
    expect(prepareSpeech("_wrapped_ text").text).toBe("wrapped text");
  });

  it("removes html tags", () => {
    expect(prepareSpeech("<p>Hello <strong>there</strong></p>").text).toBe("Hello there");
  });

  it("removes blockquote markers", () => {
    expect(prepareSpeech("> Quoted line\n> continues here").text).toBe(
      "Quoted line continues here",
    );
  });

  it("joins paragraphs with a single space and collapses whitespace", () => {
    expect(prepareSpeech("First paragraph here.\n\nSecond  paragraph   here.").text).toBe(
      "First paragraph here. Second paragraph here.",
    );
  });

  it("drops horizontal rules", () => {
    expect(prepareSpeech("Above the rule\n\n---\n\nBelow the rule").text).toBe(
      "Above the rule Below the rule",
    );
  });

  it("keeps the sentence before a truncated list and terminates the notice", () => {
    expect(prepareSpeech("- Do the thing\n\n```\nx = 1\n```").text).toBe(
      "Do the thing. Details are in the thread.",
    );
  });
});

describe("createSpeechChunker", () => {
  it("says nothing while the reply is still mid sentence", () => {
    expect(createSpeechChunker().push("The build finished")).toEqual([]);
  });

  it("releases the first chunk at a clause boundary once six words are spoken", () => {
    const chunker = createSpeechChunker();
    expect(chunker.push("one two three four five six seven, eight nine")).toEqual([
      "one two three four five six seven,",
    ]);
  });

  it("does not use a clause boundary before six words", () => {
    expect(createSpeechChunker().push("one two three, four five")).toEqual([]);
  });

  it("releases the first chunk at an em dash clause boundary", () => {
    expect(createSpeechChunker().push("one two three four five six seven — eight nine")).toEqual([
      "one two three four five six seven",
    ]);
  });

  it("says nothing when the reply only holds code", () => {
    const chunker = createSpeechChunker();
    expect(chunker.push("```ts\nconst x = 1;\n```")).toEqual([]);
    expect(chunker.finish()).toEqual([]);
  });

  it("splits a long run without clause boundaries at spaces", () => {
    const markdown = `${"alpha ".repeat(50)}omega. Done.`;
    const chunker = createSpeechChunker();
    const chunks = [...chunker.push(markdown), ...chunker.finish()];

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(220);
    }
    expect(chunks.join(" ")).toBe(prepareSpeech(markdown).text);
  });

  it("uses only sentence boundaries after the first chunk", () => {
    const chunker = createSpeechChunker();
    const opening = "one two three four five six seven, eight nine ten, eleven twelve";
    expect(chunker.push(opening)).toEqual(["one two three four five six seven, eight nine ten,"]);
    expect(chunker.push(`${opening} thirteen`)).toEqual([]);
    expect(chunker.push(`${opening} thirteen fourteen. More text here`)).toEqual([
      "eleven twelve thirteen fourteen.",
    ]);
    expect(chunker.finish()).toEqual(["More text here"]);
  });

  it("never splits decimals or versions", () => {
    const chunker = createSpeechChunker();
    expect(chunker.push("Version v0.1.1 shipped with 1.5x speed. More")).toEqual([
      "Version v0.1.1 shipped with 1.5x speed.",
    ]);
  });

  it("never splits abbreviations", () => {
    expect(createSpeechChunker().push("Install it, e.g. the CLI, then run. Next")).toEqual([
      "Install it, e.g. the CLI, then run.",
    ]);
    expect(createSpeechChunker().push("Ask Dr. Smith about v2 vs. v3 later. Next")).toEqual([
      "Ask Dr. Smith about v2 vs. v3 later.",
    ]);
  });

  it("does not emit an unfinished trailing sentence", () => {
    const chunker = createSpeechChunker();
    expect(chunker.push("Alpha beta gamma. Delta")).toEqual(["Alpha beta gamma."]);
    expect(chunker.finish()).toEqual(["Delta"]);
  });

  it("streams a three sentence paragraph to the same text as one prepareSpeech pass", () => {
    const markdown = "First sentence here. Second one follows. Third is last.";
    const chunker = createSpeechChunker();
    const chunks: string[] = [];
    for (let length = 1; length <= markdown.length; length += 1) {
      chunks.push(...chunker.push(markdown.slice(0, length)));
    }
    chunks.push(...chunker.finish());

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(" ")).toBe(prepareSpeech(markdown).text);
  });

  it("streams markdown constructs to the same text as one prepareSpeech pass", () => {
    const samples = [
      "- add the cache\n- ship it\n\nThen the **release** note mentions `src/state/npmRelease.ts`.",
      "Use snake_case and commit 64a4472d3. Read [the docs](https://example.com/a) too.",
      "# Title\n\nA short paragraph, with a comma, and more words after it.",
    ];
    for (const sample of samples) {
      const chunker = createSpeechChunker();
      const chunks: string[] = [];
      for (let length = 1; length <= sample.length; length += 1) {
        chunks.push(...chunker.push(sample.slice(0, length)));
      }
      chunks.push(...chunker.finish());
      expect(chunks.join(" ")).toBe(prepareSpeech(sample).text);
    }
  });

  it("withholds text inside unclosed emphasis", () => {
    const chunker = createSpeechChunker();
    const chunks = chunker.push("Hello there friend. Then **bol");
    expect(chunks.join(" ")).not.toContain("bol");
    expect(chunker.finish().join(" ")).toBe("Then bol");
  });

  it("withholds text inside an unclosed link", () => {
    const chunker = createSpeechChunker();
    const chunks = chunker.push("Hello there friend. Then [the docs](htt");
    expect(chunks.join(" ")).not.toContain("docs");
    expect(chunker.finish().join(" ")).toBe("Then the docs");
  });

  it("flushes markdown that never closed when the stream ends", () => {
    const chunker = createSpeechChunker();
    expect(chunker.push("Here is **bold")).toEqual([]);
    expect(chunker.finish()).toEqual(["Here is bold"]);
    expect(chunker.finish()).toEqual([]);
  });

  it("splits a long run into chunks of at most 220 characters", () => {
    const markdown = `${"We shipped a change, ".repeat(10)}and it finally works. More text follows.`;
    const chunker = createSpeechChunker();
    const chunks = [...chunker.push(markdown), ...chunker.finish()];

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(220);
    }
    expect(chunks.join(" ")).toBe(prepareSpeech(markdown).text);
  });

  it("emits the rest of the list after the first item", () => {
    const chunker = createSpeechChunker();
    const chunks = [...chunker.push("- add the cache\n- ship it"), ...chunker.finish()];

    expect(chunks.join(" ")).toBe("add the cache. ship it.");
  });

  it("stops for good once the reply is truncated mid stream", () => {
    const chunker = createSpeechChunker();
    const first = chunker.push("Let me explain the plan.\n\n```ts\nconst x = 1;");
    expect(first.join(" ")).toBe("Let me explain the plan. Details are in the thread.");
    expect(chunker.push("Let me explain the plan.\n\n```ts\nconst x = 1;\nconst y = 2;")).toEqual(
      [],
    );
    expect(chunker.finish()).toEqual([]);
  });

  it("speaks the tail of a reply that gets truncated after earlier chunks", () => {
    const chunker = createSpeechChunker();
    expect(chunker.push("First part is done. Second")).toEqual(["First part is done."]);
    const rest = chunker.push(
      "First part is done. Second part is here.\n\n- a\n- b\n- c\n- d\n- e\n- f",
    );
    expect(rest.join(" ")).toBe("Second part is here. Details are in the thread.");
  });

  it("stays quiet rather than retracting text a late change rewrites", () => {
    const chunker = createSpeechChunker();
    expect(chunker.push("The code abcd12. Next")).toEqual(["The code abcd12."]);
    // The token grew into a hash, so the reply no longer matches what was already spoken.
    expect(chunker.push("The code abcd123. Next")).toEqual([]);
    expect(chunker.finish()).toEqual(["hash. Next"]);
  });

  it("does not repeat chunks when the same markdown is pushed twice", () => {
    const chunker = createSpeechChunker();
    const markdown = "First sentence here. Second";
    expect(chunker.push(markdown)).toEqual(["First sentence here."]);
    expect(chunker.push(markdown)).toEqual([]);
  });

  it("finishes empty when nothing was ever pushed", () => {
    const chunker = createSpeechChunker();
    expect(chunker.finish()).toEqual([]);
  });
});
