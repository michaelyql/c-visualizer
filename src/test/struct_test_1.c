#include <stdlib.h>

struct X;

struct X {
  int field1, field2;
};

struct X* g() {
  return (struct X*) malloc(sizeof(struct X)); 
}

void f(int a, int b, int c, struct X my_struct) {
  int x = 0, y = 2, z = 3; 
  {
    printf("scope 1\n");
    int xx = 0;
  }
  // {
  //   printf("scope 2\n");
  //   int yy = 0;
  // }
}


int main() {
  int a = 0, b = 1, c;
  char d = '5';
  f(1, 2, 3, (struct X){.field1 = 1, .field2 = 2});
  int* p = (int*) malloc(sizeof(int));
  struct X x;
  struct X* xptr = &x;
  xptr = g();
  return 0;
}
