// PART 1 — local-only analysis of salesData & underReviewData. No Firestore, no files written.
const fs = require('fs');
const readline = require('readline');

function stream(file, onRow) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    rl.on('line', (line) => { if (!line.trim()) return; let r; try { r = JSON.parse(line); } catch { return; } onRow(r); });
    rl.on('close', resolve);
  });
}
const median = (arr) => { if (!arr.length) return 0; const s=[...arr].sort((a,b)=>a-b); const m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2; };
const maxOf = (arr) => { let m=-Infinity; for(const v of arr) if(v>m)m=v; return m; };
const p = (n) => n.toLocaleString('en-US');

async function analyze(name, file, invNames) {
  let total=0, minD=null, maxD=null;
  const days=new Map();               // date -> Set(codes)
  const allCodes=new Set();
  const codeDayRows=new Map();        // "date|code" -> raw row count
  const unmatched=new Set();

  await stream(file, (r) => {
    total++;
    const date=r.date||'(no-date)'; const code=r.itemCode||'(no-code)';
    allCodes.add(code);
    if(date!=='(no-date)'){ if(!minD||date<minD)minD=date; if(!maxD||date>maxD)maxD=date; }
    if(!days.has(date)) days.set(date,new Set());
    days.get(date).add(code);
    const k=date+'|'+code; codeDayRows.set(k,(codeDayRows.get(k)||0)+1);
    if(!invNames.has(code)) unmatched.add(code);
  });

  const perDay=[...days.values()].map(s=>s.size);
  const avgPerDay=perDay.reduce((a,b)=>a+b,0)/perDay.length;
  const maxPerDay=maxOf(perDay);
  const rowsPer=[...codeDayRows.values()];
  const avgRows=rowsPer.reduce((a,b)=>a+b,0)/rowsPer.length;
  const maxRows=maxOf(rowsPer);
  const dupGroups=rowsPer.filter(v=>v>1).length;

  console.log(`\n########## ${name} ##########`);
  console.log(`1. Total records:            ${p(total)}`);
  console.log(`2. Date range:               ${minD}  ->  ${maxD}`);
  console.log(`3. Distinct days w/ sales:   ${p(days.size)}`);
  console.log(`4. Distinct item codes:      ${p(allCodes.size)}`);
  console.log(`5. Codes PER DAY -> avg ${avgPerDay.toFixed(1)}  median ${median(perDay)}  max ${maxPerDay}`);
  console.log(`6. Duplication (rows per code+day): avg ${avgRows.toFixed(2)}  max ${maxRows}`);
  console.log(`   code+day groups with >1 row: ${p(dupGroups)} of ${p(codeDayRows.size)} (${(dupGroups/codeDayRows.size*100).toFixed(1)}%)`);
  console.log(`7. Distinct codes with NO inventory name match: ${p(unmatched.size)} of ${p(allCodes.size)} (${(unmatched.size/allCodes.size*100).toFixed(1)}%)`);
}

(async () => {
  // inventory names + presence
  const invNames=new Set();
  await stream('./backup/inventoryData.jsonl',(r)=>{ if(r.itemCode) invNames.add(r.itemCode); });

  console.log('===== PART 1: DATA UNDERSTANDING (local only, nothing billed) =====');
  console.log(`inventoryData distinct item codes (name source): ${p(invNames.size)}`);
  await analyze('salesData', './backup/salesData.jsonl', invNames);
  await analyze('underReviewData', './backup/underReviewData.jsonl', invNames);

  console.log('\n===== CONFIRMED FIELD NAMES (schema) =====');
  console.log('salesData:        date=`date`  itemCode=`itemCode`  units=`unitsSold`  sellingPrice=`sellingPrice`  cost=`unitCost` (also totalCost, grossProfit, resolvedAt, costMethod)');
  console.log('underReviewData:  date=`date`  itemCode=`itemCode`  units=`unitsSold`  sellingPrice=`sellingPrice`  cost=NONE (no unitCost/totalCost)');
  console.log('inventoryData:    itemCode=`itemCode`  name=`description`  cost=`unitCost`  costDate=`dateDelivered`');
})();
