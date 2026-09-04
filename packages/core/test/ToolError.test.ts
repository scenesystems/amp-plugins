import { describe, it } from "@effect/vitest"
import * as Assert from "@effect/vitest/utils"
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import * as Schema from "effect/Schema"
import * as ToolError from "../src/ToolError.ts"

class Boom extends Schema.TaggedError<Boom>()("Boom", { message: Schema.String }) {}

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
    Assert.assertSome(ToolError.render(new ToolError.ToolError({ message: "m" })), "Error: m")
    Assert.assertSome(ToolError.render(new ToolError.ToolError({ message: "m", hint: "h" })), "Error: m\nHint: h")
  })

  it("renders any tagged error with a message under its tag", () => {
    Assert.assertSome(ToolError.render(new Boom({ message: "x" })), "Boom: x")
    Assert.assertSome(ToolError.render({ message: "untagged" }), "Error: untagged")
    Assert.assertSome(ToolError.render({ _tag: 7, message: "numeric tag" }), "Error: numeric tag")
  })

  it("renders a SchemaError under the SchemaError tag", () => {
    const issue = Schema.decodeUnknownResult(Schema.Struct({ a: Schema.String }))({})
    Assert.assertTrue(issue._tag === "Failure")
    Assert.assertSome(ToolError.render(issue.failure), "SchemaError: Missing key\n  at [\"a\"]")
  })

  it("returns None when there is nothing readable to show", () => {
    Assert.assertNone(ToolError.render("a string"))
    Assert.assertNone(ToolError.render(42))
    Assert.assertNone(ToolError.render(null))
    Assert.assertNone(ToolError.render({ message: 42 }))
    Assert.assertNone(ToolError.render({}))
  })
})
