library(magrittr)

data <- data.csv("data.csv")
data %>%
   dplyr::group_by(group) %>%
   dplyr::do(anova(lm(value ~ treatment, data = .))) -> anova_results

read.csv("hello")
read.csv(path.expand("blah"))

write.csv(anova_results, "anova_results.csv")

library(ggplot2)
ggplot(mpg, aes(displ, hwy, colour = class)) +
  geom_point()

sink("./test.txt")
cat("Hello")
