# To Do

## Language Features

- Literals
- Binary operation
- Declaration
- Assignment
- Expression
- Basic data types (int, char, byte, bool, string, float, double, long long)
- Main function
- Function declaration
- Return type
- Function arguments
- Control, Environment, Store, Continuation
- Control flow (if, else, while, for)
- Function call
- Type checking
- lvalue vs rvalue checking
- Pass by value
- Syntax errors
- Redeclaring variables, variable name collision
- Pointer
- Array
- array initialization syntax support
- Runtime errors
- Struct
- Union
- Type casting
- multidimensional arrays
- flexible array member (not fixed size array)
- function pointers
- function objects
- string as array of chars
- sizeof operator (compile time check)
- Syntax checker e.g. no 0-sized array (see [reference](https://stackoverflow.com/questions/9722632/what-happens-if-i-define-a-0-size-array-in-c-c))
- malloc
- C calling convetion: see [cdeck](https://learn.microsoft.com/en-us/cpp/cpp/cdecl?view=msvc-170)

Refer to [here](https://docs.google.com/document/d/13_Bc-l2FKMgwPx4dZb0sv7eMfYMHhRVgBRShha8kgbU/edit?tab=t.0) for pythontutor limitations

## Architecture

- supported virtual memory size
- design decision: limit to 1GB virtual memory
- problem with visualizer state: state copy per step of execution will balloon memory
- stack space is limited: default 1MB
- fixed size local array also limited, can't exceed stack size
- pythontutor fixed array breaks at 1024 size (still displays table but it gets really wide and the code just aborts)
- code snippets
- how to visualize and lay out memory
- copy-on-write / persistent data structure / [HAMT](https://en.wikipedia.org/wiki/Hash_array_mapped_trie) to store changes between states so as to avoid deep expensive copy of states, since each instruction/step only touches a small part of the state
- add a debounce to compute the changes between states when user drags slider/clicks on next/prev/last/first
- compressing data/arrays of large size (?)
