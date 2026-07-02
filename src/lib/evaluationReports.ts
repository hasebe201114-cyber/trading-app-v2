/**
 * ⑦評価・チューニング層 — 評価レポートの Firestore 読み書き
 *
 * scripts/generate-evaluation-report.ts が生成する JSON スナップショットと同じ形を
 * `evaluationReports` コレクションに保存する（1ドキュメント = 1レポート）。
 * docId は generatedAt ベースの決定的な値とし、同じレポートを何度保存しても
 * 重複ドキュメントが増えないようにしている。
 */

import {
  collection,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import { db } from './firebase';

export interface EvaluationFold {
  label: string;
  tradeCount: number;
  winRate: number;
  totalReturn: number;
  maxDrawdown: number;
  sharpeRatio: number;
}

export interface EvaluationReport {
  generatedAt: string;
  config: { horizon: number; k: number; initialEquity: number };
  dataSource: string;
  caveats: string[];
  targets: { directionAccuracy: number; sharpeRatio: number; maxDrawdown: number };
  folds: EvaluationFold[];
  summary: {
    avgSharpeRatio: number;
    minSharpeRatio: number;
    maxDrawdownAcrossFolds: number;
    foldsAboveSharpeTarget: number;
    foldsWithinDrawdownTarget: number;
    totalFolds: number;
  };
}

const COLLECTION = 'evaluationReports';

/** generatedAt(ISO文字列) を Firestore docId に使える形へ変換（コロン等を除去） */
function reportDocId(generatedAt: string): string {
  return generatedAt.replace(/[:.]/g, '-');
}

export async function saveEvaluationReport(report: EvaluationReport): Promise<void> {
  const ref = doc(db, COLLECTION, reportDocId(report.generatedAt));
  await setDoc(ref, { ...report, uploadedAt: serverTimestamp() });
}

export async function fetchLatestEvaluationReport(): Promise<EvaluationReport | null> {
  const q = query(collection(db, COLLECTION), orderBy('generatedAt', 'desc'), limit(1));
  const snapshot = await getDocs(q);
  if (snapshot.empty) return null;
  return snapshot.docs[0].data() as EvaluationReport;
}
