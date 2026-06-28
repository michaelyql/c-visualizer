# Tree Sitter Notes

Each tree sitter node has a **type**. It is the first element in the S-expression. For example,

```
(function_definition
    type: (primitive_type)
    declarator: (function_declarator
        declarator: ...
```

`function_definition` is the **node type**.

`type` and `declarator` are **labels** (think of them as aliases to easily select children by their name instead of their explicit type). Labels are followed by a colon with the type of the node. Labels are also called "field names". Labels are optional.

Nodes can have **child nodes**. In this case, `type` and `declarator` are child nodes of `function_declaration`

Nodes can also have **properties** (i.e. javascript object properties)

## `declaration`

- `type`:
- `declarator`:

## `function_declaration`

- `declarator`: `identifier`
- `parameters`: `parameter_list`

## `function_definition`

- `type`:
- `declarator`: `function_declarator`
- `body`: `compound_statement`

## `parameter_list`

- `parameter_declaration` (can have zero or more of these as child nodes)

## `parameter_declaration`

- `type`:
- `declarator`: `identifier`

## `identifier`

### Properties

- `text` (The identifier itself)
