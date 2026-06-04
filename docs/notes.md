## 1. The AST Structure

The tree consists of distinct node classes (e.g., Literal, BinaryExpression, IfStatement). Each node class corresponds directly to a syntactic construct in the language

- Literals: Leaf nodes that represent raw values (e.g., numbers or strings).
- Expressions/Statements: Branch nodes representing operations or control flow

## 2. The Evaluation Strategy

There are two primary ways to implement the evaluation logic on these nodes:

- Interpreter Pattern: Each node class contains an interpret() or evaluate() method. The tree evaluates itself by having the root node call interpret() on its children, and so on.
- Visitor Pattern: Keeps the tree classes clean by separating the interpretation logic into an external "visitor" class. This allows you to add type-checking, compiling, and interpretation without modifying the node classes themselves.

## 3. Execution Context

Because an AST handles variable scope and assignments, your interpreter needs an execution environment:

- Environment Map: A dictionary or map structure to bind variable names to their current runtime values.
- Scope Chains: A stack of environments that handles block-level scoping and function closures

## Links

- https://en.wikipedia.org/wiki/Interpreter_pattern
- https://craftinginterpreters.com/representing-code.html
- https://craftinginterpreters.com/

## S-expression

A.k.a symbolic expression, is a notation for representing hierarchical data, using nested parentheses

### The Basic Rules

S-expressions have a simple, recursive structure:

- Atoms – The most basic building blocks. These can be:
    - Symbols (names, like program, class_declaration)
    - Strings ("hello")
    - Numbers (42, 3.14)
    - Booleans (true, false)
- Lists – Sequences of atoms or other lists, enclosed in parentheses ( )
    - Elements are separated by whitespace (spaces or newlines)
    - Lists can be nested arbitrarily deep

### Sample S-expression of tree-sitter

```
(program
  (class_declaration
    name: (identifier)
    body: (class_body
      (method_declaration
        type: (void_type)
        name: (identifier)
        parameters: (formal_parameters)
        body: (block
          (expression_statement
            (method_invocation
              object: (identifier)
              name: (identifier)
              arguments: (argument_list
                (string_literal)))))))))
```

### 1. The Basic Structure: Parentheses and Nodes

The entire tree is one giant S-expression, which is why it starts and ends with parentheses. Every pair of parentheses `( ... )` represents a single node in the tree.

- Node Type: The first word inside the parentheses is the node's type. It tells you what kind of code construct it represents.
    - `(program ...)` - The root of the whole file.
    - `(class_declaration ...)` - A class definition.
    - `(identifier)` - A name, like a variable or function name.
    - `(string_literal)` - A piece of text, like "arg".

### 2. Annotations: Field Names

You will often see words followed by a colon `:`, like `name:`, `body:`, or `arguments:`. These are **field names**.

Think of them as **labels** on the branches of the tree. While the node type tells you _what_ a piece of code is (e.g., an `identifier`), the field name tells you what _role_ that piece of code plays in its parent (e.g., it is the name: of a method).

For example, in the method_invocation node for `obj.func2("arg")`, the field names clarify the role of each part:

```
(method_invocation
  object: (identifier) # The 'object' the method is called on (obj)
  name: (identifier) # The 'name' of the method being called (func2)
  arguments: (argument_list ...) # The list of 'arguments' passed to it ("arg"))
```

Without these field names, you would just see a list of three identifier nodes and wouldn't know which one is the object and which is the method name. They add crucial semantic meaning.

### 3. Hierarchy and Children

Indentation is used to show the tree's **hierarchy**—how nodes contain other nodes.

A node's children are the nodes nested directly inside it.

In the example, the `program` node contains the `class_declaration` node.

The `class_declaration` node then contains its own children: the `name:` field node `(identifier)` and the `body:` field node `(class_body ...)`.

This nesting continues until you reach **leaf nodes**, like `(identifier)` or `(string_literal)`, which have no children of their own.

### What a Node Contains

When you inspect a node programmatically, you're not limited to just the S-expression text. A node object provides useful metadata about its place in the source code:

| Property/Method         | What it tells you                                            | Example                   |
| ----------------------- | ------------------------------------------------------------ | ------------------------- |
| type                    | The node's name as a string.                                 | `"method_invocation"`     |
| start_byte / end_byte   | The exact position in the file (as a byte index).            | Where `obj.func2` starts. |
| start_point / end_point | The line and row where the node starts and ends (0-indexed). | `{row: 3, column: 8}`     |
| text                    | The actual source code that the node represents.             | `"obj.func2(\"arg\")"`    |

### Why This Matters: Queries

The real power of this structured output is that you can search it. Tree-sitter has its own **query language**, which looks very similar to the S-expression output but lets you capture specific patterns.

For example, you could write a query to find all `method_invocation` nodes where the method `name:` is `"func2"`. The query syntax uses the same ideas of node types, field names (name:), and special `@capture` tags to extract information.

In short, Tree-sitter's output is a highly structured, human-readable map of your code's grammar. Once you recognize that parentheses enclose nodes, colons label roles, and indentation shows the hierarchy, you can effectively "read" the tree that Tree-sitter builds.

## Open Source C Interpreters

- Picoc https://gitlab.com/zsaleeba/picoc
- Pythontutor https://pythontutor.com/c.html#mode=edit
- Cling https://github.com/root-project/cling
- https://www.robertwinkler.com/projects/c_interpreter.html
- https://github.com/rswinkle/C_Interpreter/tree/master/src
- https://github.com/lotabout/write-a-C-interpreter/blob/master/README.md
- cynterpreter https://github.com/MohamedIrfanAM/cynterpreter/tree/master
- https://mohamedirfanam.medium.com/building-a-c-interpreter-from-scratch-89336fc91bf2
- https://www.youtube.com/watch?v=HfQMlJaLTNk

Guide: https://craftinginterpreters.com/a-map-of-the-territory.html
