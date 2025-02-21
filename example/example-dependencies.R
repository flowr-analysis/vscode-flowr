library(magrittr)

data <- data.csv("data.csv")
data %>%
   dplyr::group_by(group) %>%
   dplyr::do(anova(lm(value ~ treatment, data = .))) -> anova_results

write.csv(anova_results, "anova_results.csv")
