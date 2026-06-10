#include <stdlib.h>

void f(int a, int b, int c) {
  int x = 0, y = 2, z = 3; 
}

struct X;

struct X {
  int field1, field2;
};

struct X* g() {
  return (struct X*) malloc(sizeof(struct X)); 
}

int main() {
  int a = 0, b = 1, c;
  char d = '5';
  f(1, 2, 3);
  int* p = (int*) malloc(sizeof(int));
  struct X x;
  struct X* xptr = &x;
  xptr = g();
  return 0;
}
