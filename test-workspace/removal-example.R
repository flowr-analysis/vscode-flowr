library(ggplot2)
raw <- read.csv("data.csv")
helper <- raw$a * 2
plot(helper)
summary(raw)
