library(ggplot2)
raw <- read.csv("data.csv")
# only for the scatter plot
scaled <- raw$a * 2
png("scatter.png")
plot(scaled)
dev.off()
for(i in 1:2) {
  tmp <- raw$b + i
  write.csv(tmp, paste0("out", i, ".csv"))
  print(i)
}
summary(raw)
x <- 1; y <- 2
print(y)
bars <- data.frame(a = 1:3)
ggplot(bars, aes(a)) + geom_bar()
ggsave("bars.png")
