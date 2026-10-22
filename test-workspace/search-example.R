library(dplyr)
data <- read.csv("measurements.csv")
clean <- filter(data, value > 0)
scale <- function(v) v * 2
result <- scale(clean$value)
print(result)
