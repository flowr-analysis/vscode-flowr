library(ggplot2)
x <- read.csv("data.csv")
y <- x
write.csv(y, "out.csv")
plot(y)
z <- 1 + 2
