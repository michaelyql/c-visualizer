# Design

Here we discuss design decisions and tradeoffs.

## C Grammar / web-tree-sitter AST

The top-most level (root node of the AST) is always a `translation_unit` node. At the file / global scope, only the following are allowed:

- function declarations / definitions
- variable declarations / initialization
- struct / enum / union / type definitions
- preprocessor directives

All other statements must appear inside a function body or block statement.

For example, the following are not valid C programs:

```cpp
// a.cpp
1 + 2;

// b.cpp
{
    1 + 2;
}

// c.cpp
int x = 1, y = 2;
x + y;

// d.cpp
foo();

// e.cpp
while (...) {}
```

## Node Documentation

### Node Types

```typescript
type NodeType =
    // Root
    | "translation_unit"

    // Preprocessor
    | "preproc_include"
    | "preproc_def"
    | "preproc_function_def"
    | "preproc_params"
    | "preproc_call"
    | "preproc_if"
    | "preproc_ifdef"
    | "preproc_else"
    | "preproc_elif"
    | "preproc_elifdef"
    | "preproc_arg"
    | "preproc_directive"
    | "preproc_defined"

    // Definitions & declarations
    | "function_definition"
    | "declaration"
    | "type_definition"
    | "init_declarator"
    | "declaration_list"
    | "linkage_specification"
    | "parameter_list"
    | "parameter_declaration"
    | "variadic_parameter"

    // Declarators
    | "pointer_declarator"
    | "function_declarator"
    | "array_declarator"
    | "parenthesized_declarator"
    | "attributed_declarator"
    | "abstract_pointer_declarator"
    | "abstract_function_declarator"
    | "abstract_array_declarator"
    | "abstract_parenthesized_declarator"

    // Type specifiers & qualifiers
    | "primitive_type"
    | "sized_type_specifier"
    | "type_identifier"
    | "type_qualifier"
    | "storage_class_specifier"
    | "alignas_qualifier"
    | "type_descriptor"
    | "macro_type_specifier"

    // Structs / unions / enums
    | "struct_specifier"
    | "union_specifier"
    | "field_declaration_list"
    | "field_declaration"
    | "bitfield_clause"
    | "enum_specifier"
    | "enumerator_list"
    | "enumerator"

    // Statements
    | "compound_statement"
    | "expression_statement"
    | "if_statement"
    | "else_clause"
    | "switch_statement"
    | "case_statement"
    | "while_statement"
    | "do_statement"
    | "for_statement"
    | "return_statement"
    | "break_statement"
    | "continue_statement"
    | "goto_statement"
    | "labeled_statement"
    | "attributed_statement"

    // Expressions
    | "binary_expression"
    | "unary_expression"
    | "update_expression"
    | "assignment_expression"
    | "conditional_expression"
    | "comma_expression"
    | "pointer_expression"
    | "cast_expression"
    | "sizeof_expression"
    | "alignof_expression"
    | "offsetof_expression"
    | "generic_expression"
    | "extension_expression"
    | "call_expression"
    | "argument_list"
    | "subscript_expression"
    | "field_expression"
    | "parenthesized_expression"
    | "compound_literal_expression"

    // Initializers
    | "initializer_list"
    | "initializer_pair"
    | "subscript_designator"
    | "subscript_range_designator"
    | "field_designator"

    // Literals & terminals
    | "identifier"
    | "field_identifier"
    | "statement_identifier"
    | "number_literal"
    | "char_literal"
    | "character"
    | "string_literal"
    | "string_content"
    | "concatenated_string"
    | "escape_sequence"
    | "system_lib_string"
    | "true"
    | "false"
    | "null"

    /*
    // GNU asm
    | "gnu_asm_expression"
    | "gnu_asm_qualifier"
    | "gnu_asm_output_operand_list"
    | "gnu_asm_output_operand"
    | "gnu_asm_input_operand_list"
    | "gnu_asm_input_operand"
    | "gnu_asm_clobber_list"
    | "gnu_asm_goto_list"
    */

    /*
    // MS extensions / SEH
    | "ms_call_modifier"
    | "ms_declspec_modifier"
    | "ms_based_modifier"
    | "ms_pointer_modifier"
    | "ms_restrict_modifier"
    | "ms_unsigned_ptr_modifier"
    | "ms_signed_ptr_modifier"
    | "ms_unaligned_ptr_modifier"
    | "seh_try_statement"
    | "seh_except_clause"
    | "seh_finally_clause"
    | "seh_leave_statement"
    */

    // Attributes
    | "attribute_specifier"
    | "attribute_declaration"
    | "attribute"

    // Misc
    | "comment"
    | "ERROR"
    | "MISSING";
```

## Intermediate Representation (IR)

Code:

```cpp
const int x = 5;
```

web-tree-sitter AST:

```
(translation_unit (declaration (type_qualifier) type: (primitive_type) declarator: (init_declarator declarator: (identifier) value: (number_literal))))
```

Pretty printed:

```
translation_unit [0,0] - [0,16]
  declaration [0,0] - [0,16]
    type_qualifier [0,0] - [0,5]  "const"
    type: primitive_type [0,6] - [0,9]  "int"
    declarator: init_declarator [0,10] - [0,15]
      declarator: identifier [0,10] - [0,11]  "x"
      value: number_literal [0,14] - [0,15]  "5"
```

## Lowering to IR

### Functions

Functions are either declared or defined

function_definition:

- `type` (return type)
- `declarator` (fn name)
- `body`

declaration
