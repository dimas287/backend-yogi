const fs = require("fs");

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Penggunaan: node scripts/calculate-usability.js <hasil-kuesioner.csv>");
  process.exit(1);
}

const lines = fs.readFileSync(inputPath, "utf8")
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);

if (lines.length < 2) {
  console.error("Belum ada jawaban responden pada file CSV.");
  process.exit(1);
}

const expectedHeader = ["responden", "q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8", "q9", "q10"];
const header = lines[0].split(",").map(value => value.trim().toLowerCase());
if (header.join(",") !== expectedHeader.join(",")) {
  console.error(`Header harus: ${expectedHeader.join(",")}`);
  process.exit(1);
}

const responses = lines.slice(1).map((line, rowIndex) => {
  const columns = line.split(",").map(value => value.trim());
  const scores = columns.slice(1).map(Number);
  if (columns.length !== 11 || scores.some(score => !Number.isInteger(score) || score < 1 || score > 5)) {
    throw new Error(`Baris ${rowIndex + 2} tidak valid. Seluruh skor harus berupa bilangan 1-5.`);
  }
  return { respondent: columns[0], scores };
});

const indicators = [
  { name: "Kemudahan akses", questions: [0, 1] },
  { name: "Kemudahan navigasi", questions: [2] },
  { name: "Kejelasan informasi", questions: [3, 4, 5] },
  { name: "Kemudahan penggunaan fitur", questions: [6, 7, 8] },
  { name: "Manfaat sistem", questions: [9] }
];

function getCategory(percentage) {
  if (percentage <= 20) return "Sangat kurang";
  if (percentage <= 40) return "Kurang";
  if (percentage <= 60) return "Cukup";
  if (percentage <= 80) return "Baik";
  return "Sangat baik";
}

const results = indicators.map(indicator => {
  const score = responses.reduce((total, response) => {
    return total + indicator.questions.reduce((subtotal, questionIndex) => {
      return subtotal + response.scores[questionIndex];
    }, 0);
  }, 0);
  const maximum = indicator.questions.length * 5 * responses.length;
  const percentage = (score / maximum) * 100;
  return { indicator: indicator.name, score, maximum, percentage: Number(percentage.toFixed(2)) };
});

const totalScore = results.reduce((sum, result) => sum + result.score, 0);
const totalMaximum = results.reduce((sum, result) => sum + result.maximum, 0);
const totalPercentage = (totalScore / totalMaximum) * 100;

console.log(JSON.stringify({
  respondents: responses.length,
  indicators: results,
  total: {
    score: totalScore,
    maximum: totalMaximum,
    percentage: Number(totalPercentage.toFixed(2)),
    category: getCategory(totalPercentage)
  }
}, null, 2));
