### Core Language Support

- Data Types: int, float, char, bool, string
- Variable Declaration and Assignment: Type-safe variable declarations with optional initialization
- Arrays: Static array declarations with literal initialization and index-based access
- Functions: Function declarations, parameters, return values, and function calls
- Control Flow: if-else statements, while loops, for loops
- Operators:
    - Arithmetic: +, -, \_, /, %
    - Comparison: ==, !=, <, <=, >, >=
    - Logical: &&, ||, !
    - Assignment: =, +=, -=, \_=, /=, %=
    - Unary: +, - (prefix)
- Built-in Functions
    - print() - Print values to stdout
    - printf() - Formatted printing with format strings
    - input() - Read input from stdin with optional prompt

### Language Features

- Type Safety: Runtime type checking for variables and function parameters
- Scope Management: Proper variable scoping with nested environments
- Error Handling: Comprehensive error reporting for parsing and runtime errors
- Expression Evaluation: Support for complex nested expressions with proper operator precedence
- Automatic Garbage Collection: Memory management handled automatically by Go's runtime GC
- Memory Safety: No buffer overflows or dangling pointer issues due to Go's memory model
- Unicode Support: Full UTF-8 string handling
- Stack Overflow Protection: Automatic stack management and overflow detection
- Bounds Checking: Array and string access bounds checking to prevent memory corruption

### Missing Features

The following C language features are not yet implemented:

- Pointers: No pointer support (\*, & operators)
- Structs/Unions: No composite data types
- Preprocessor: No #include, #define, or other preprocessor directives
- Switch Statements: No switch-case support
- Multiple File Support: Single file compilation only
- Dynamic Memory: No malloc/free support
- Standard Library: Limited built-in functions
- Type Modifiers: No const, volatile, static, etc.
- Advanced Numeric Types: No long, double, unsigned variants
- Bit Fields: No bit manipulation structures
