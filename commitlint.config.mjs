export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // subjects legitimately contain proper nouns (Agrippa, 硅基工坊, Drizzle…)
    "subject-case": [0],
  },
};
