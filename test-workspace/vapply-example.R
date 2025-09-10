v <- c("a", "b", "c")
lapply(v, library, character.only = TRUE)

v <- c("d", "e", "f")
vapply(v, library, character.only = TRUE)
