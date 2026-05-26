import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { detectDocument, saveWarped } from "./detectDocument";

const INPUT = process.argv[2] ?? "test-images/doc.jpg";
const OUTPUT_DIR = "output";

async function run() {
  if (!fs.existsSync(INPUT)) {
    console.error(`Image not found: ${INPUT}`);
    console.error("Usage: npm run detect [path/to/image.jpg]");
    process.exit(1);
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log(`Processing: ${INPUT}`);
  const t0 = Date.now();

  const result = await detectDocument(INPUT);

  console.log(`Detection: ${Date.now() - t0}ms`);
  console.log("Corners (tl → tr → br → bl):");
  const labels = ["top-left", "top-right", "bottom-right", "bottom-left"];
  result.corners.forEach((pt, i) =>
    console.log(`  ${labels[i].padEnd(12)} x=${pt.x}, y=${pt.y}`)
  );
  console.log(`Warped size: ${result.width} × ${result.height}px`);

  const stem = path.basename(INPUT, path.extname(INPUT));
  const outputPath = path.join(OUTPUT_DIR, `${stem}-warped.png`);
  await saveWarped(result.warped, result.width, result.height, outputPath);
  result.warped.delete();

  console.log(`Saved → ${outputPath}`);
  execSync(`open "${outputPath}"`);
}

run().catch((err) => {
  console.error("Error:", (err as Error).message);
  process.exit(1);
});
