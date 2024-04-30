sum <- 0
product <- 1
w <- 7
n <- 10

for (i in 1:(n - 1)) {
  sum <- sum + i + w
  product <- product * i
}

cat("Sum:", sum, "\n")
cat("Product:", product, "\n")
