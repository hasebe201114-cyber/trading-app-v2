import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ProjectExperiment {
  obsId: string;
  name: string;
  status: 'adopted' | 'rejected' | 'in-progress' | 'exploring' | 'pending';
  conclusion?: string;
  details?: string;
  date?: string;
  day90Progress?: number; // OBS000032用：0-100%
}

interface ProjectStatus {
  timestamp: string;
  phase: string;
  adopted: ProjectExperiment[];
  rejected: ProjectExperiment[];
  inProgress: ProjectExperiment[];
  exploring: ProjectExperiment[];
  pending: ProjectExperiment[];
  summary: {
    totalAdopted: number;
    totalRejected: number;
    totalInProgress: number;
  };
}

function parsePortfolioLedger(): ProjectStatus {
  const ledgerPath = path.join(__dirname, '../research/portfolio-ledger.md');
  const content = fs.readFileSync(ledgerPath, 'utf-8');

  const result: ProjectStatus = {
    timestamp: new Date().toISOString(),
    phase: 'Phase 0 - フォワード較正フェーズ',
    adopted: [],
    rejected: [],
    inProgress: [],
    exploring: [],
    pending: [],
    summary: {
      totalAdopted: 0,
      totalRejected: 0,
      totalInProgress: 0,
    },
  };

  // 採用実験の抽出
  const adoptedSection = content.match(/## 採用.*?(?=##|$)/s)?.[0] || '';
  const adoptedRows = adoptedSection.match(/\|\s*OBS\d+.*?\|/g) || [];
  adoptedRows.forEach((row) => {
    const match = row.match(/\|\s*(OBS\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|/);
    if (match) {
      result.adopted.push({
        obsId: match[1],
        name: match[2].trim(),
        status: 'adopted',
        conclusion: match[3].trim(),
        details: match[4].trim(),
      });
    }
  });

  // 不採用実験の抽出
  const rejectedSection = content.match(/## 不採用.*?(?=##|$)/s)?.[0] || '';
  const rejectedRows = rejectedSection.match(/\|\s*OBS\d+.*?\|/g) || [];
  rejectedRows.forEach((row) => {
    const match = row.match(/\|\s*(OBS\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|/);
    if (match) {
      result.rejected.push({
        obsId: match[1],
        name: match[2].trim(),
        status: 'rejected',
        conclusion: match[3].trim(),
      });
    }
  });

  // 進行中実験の抽出
  const inProgressSection = content.match(/## 進行中.*?(?=##|$)/s)?.[0] || '';
  const inProgressRows = inProgressSection.match(/\|\s*OBS\d+.*?\|/g) || [];
  inProgressRows.forEach((row) => {
    const match = row.match(/\|\s*(OBS\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|/);
    if (match) {
      const obsId = match[1];
      const name = match[2].trim();
      const details = match[3].trim();

      // OBS000032 の day90 カウントダウン計算
      let day90Progress = 0;
      if (obsId === 'OBS000032') {
        const liveStart = new Date('2026-07-04'); // go-live date
        const today = new Date();
        const day90End = new Date(liveStart);
        day90End.setDate(day90End.getDate() + 90);

        const elapsed = Math.floor((today.getTime() - liveStart.getTime()) / (1000 * 60 * 60 * 24));
        day90Progress = Math.min(100, Math.max(0, (elapsed / 90) * 100));
      }

      result.inProgress.push({
        obsId,
        name,
        status: 'in-progress',
        details: details.substring(0, 200) + '...',
        date: new Date().toISOString().split('T')[0],
        day90Progress,
      });
    }
  });

  // 探索的所見の抽出
  const exploringSection = content.match(/## 探索的所見.*?(?=##|$)/s)?.[0] || '';
  const exploringRows = exploringSection.match(/\|\s*OBS\d+.*?\|/g) || [];
  exploringRows.forEach((row) => {
    const match = row.match(/\|\s*(OBS\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|/);
    if (match) {
      result.exploring.push({
        obsId: match[1],
        name: match[2].trim(),
        status: 'exploring',
        details: match[3].trim().substring(0, 200) + '...',
      });
    }
  });

  // 保留実験の抽出
  const pendingSection = content.match(/## 保留.*?(?=##|$)/s)?.[0] || '';
  const pendingRows = pendingSection.match(/\|\s*OBS\d+.*?\|/g) || [];
  pendingRows.forEach((row) => {
    const match = row.match(/\|\s*(OBS\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|/);
    if (match) {
      result.pending.push({
        obsId: match[1],
        name: match[2].trim(),
        status: 'pending',
        details: match[3].trim().substring(0, 200) + '...',
      });
    }
  });

  // サマリー集計
  result.summary.totalAdopted = result.adopted.length;
  result.summary.totalRejected = result.rejected.length;
  result.summary.totalInProgress = result.inProgress.length;

  return result;
}

function main() {
  const projectStatus = parsePortfolioLedger();

  // public/data ディレクトリを作成
  const dataDir = path.join(__dirname, '../public/data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // JSON ファイルに出力
  const outputPath = path.join(dataDir, 'project-status.json');
  fs.writeFileSync(outputPath, JSON.stringify(projectStatus, null, 2));

  console.log(`✅ Project status generated: ${outputPath}`);
  console.log(`   - 採用: ${projectStatus.summary.totalAdopted}件`);
  console.log(`   - 不採用: ${projectStatus.summary.totalRejected}件`);
  console.log(`   - 進行中: ${projectStatus.summary.totalInProgress}件`);
}

main();
