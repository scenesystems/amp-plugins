import { describe, it } from "@effect/vitest"
import * as Assert from "@effect/vitest/utils"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import * as Schema from "effect/Schema"
import * as ToolError from "../src/ToolError.ts"

describe("ToolError", () => {
  it("is yieldable and compares structurally, hint included", () =>
    Effect.gen(function*() {
      const error = new ToolError.ToolError({ message: "m", hint: "h" })
      Assert.assertTrue(Equal.equals(error, new ToolError.ToolError({ message: "m", hint: "h" })))
      Assert.assertFalse(Equal.equals(error, new ToolError.ToolError({ message: "m", hint: "other" })))
      Assert.assertFalse(Equal.equals(error, new ToolError.ToolError({ message: "m" })))
      const exit = yield* Effect.exit(new ToolError.ToolError({ message: "m" }))
      Assert.assertTrue(exit._tag === "Failure")
    }).pipe(Effect.runSync))
})

describe("ToolError.render", () => {
  it("renders a ToolError as `Error: message` plus an optional `Hint:` line", () => {
    Assert.strictEqual(ToolError.render(new ToolError.ToolError({ message: "m" })), "Error: m")
    Assert.strictEqual(ToolError.render(new ToolError.ToolError({ message: "m", hint: "h" })), "Error: m\nHint: h")
  })

  it("renders any tagged error with a message under its tag", () => {
    class Other extends Data.TaggedError("Other")<{ readonly message: string }> {}
    Assert.strictEqual(ToolError.render(new Other({ message: "x" })), "Other: x")
    Assert.strictEqual(ToolError.render(new Error("plain")), "Error: plain")
    Assert.strictEqual(ToolError.render({ message: "untagged" }), "Error: untagged")
    Assert.strictEqual(ToolError.render({ _tag: 7, message: "numeric tag" }), "Error: numeric tag")
  })

  it("renders a SchemaError under the SchemaError tag", () => {
    const issue = Schema.decodeUnknownResult(Schema.Struct({ a: Schema.String }))({})
    Assert.assertTrue(issue._tag === "Failure")
    Assert.strictEqual(ToolError.render(issue.failure), "SchemaError: Missing key\n  at [\"a\"]")
  })

  it("returns undefined when there is nothing readable to show", () => {
    Assert.assertUndefined(ToolError.render("a string"))
    Assert.assertUndefined(ToolError.render(42))
    Assert.assertUndefined(ToolError.render(null))
    Assert.assertUndefined(ToolError.render({ message: 42 }))
    Assert.assertUndefined(ToolError.render({}))
  })
})
