typedef struct {
  int a;
  int b;
  int c;
  int d;
  int e;
} foo;

int main() {
  foo* p_foo = (foo*)malloc(sizeof(*p_foo));  // right size! allocates enough space for the entire struct
  // question marks '?' mean allocated but uninitialized memory, which is fine for now

  foo* p_foo2 = (foo*)malloc(sizeof(p_foo2));
  // skulls mean UNALLOCATED memory

//   // note that the '?' are replaced by legitimate integer values ...
//   p_foo->a = 1;
//   p_foo->b = 2;
//   p_foo->c = 3;
  
//   p_foo2->a = 1;
//   p_foo2->c = 3; // error when trying to write to skull (UNALLOCATED memory block)
  return 0;
}
