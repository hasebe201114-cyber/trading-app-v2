import { useEffect, useState } from 'react';
import { SectionBox } from '../../ui/components/SectionBox';
import { MetricCard } from '../../ui/components/MetricCard';

interface ProjectExperiment {
  obsId: string;
  name: string;
  status: 'adopted' | 'rejected' | 'in-progress' | 'exploring' | 'pending';
  conclusion?: string;
  details?: string;
  date?: string;
  day90Progress?: number;
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

export const ProjectStatusBoard = () => {
  const [status, setStatus] = useState<ProjectStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchProjectStatus = async () => {
      try {
        const response = await fetch('/data/project-status.json');
        if (!response.ok) throw new Error('Failed to fetch project status');
        const data = await response.json();
        setStatus(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    };

    fetchProjectStatus();
  }, []);

  if (loading) {
    return (
      <SectionBox title="プロジェクト進捗">
        <div className="text-center text-fg-2">読み込み中...</div>
      </SectionBox>
    );
  }

  if (error || !status) {
    return (
      <SectionBox title="プロジェクト進捗">
        <div className="text-center text-red-500">
          {error ? `エラー: ${error}` : 'データが見つかりません'}
        </div>
      </SectionBox>
    );
  }

  return (
    <div className="space-y-6">
      <SectionBox title="プロジェクト進捗サマリー">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <MetricCard
            color="emerald"
            label="採用済み"
            value={status.summary.totalAdopted.toString()}
            sub="本番反映済み"
          />
          <MetricCard
            color="blue"
            label="進行中"
            value={status.summary.totalInProgress.toString()}
            sub="検証中"
          />
          <MetricCard
            color="red"
            label="不採用"
            value={status.summary.totalRejected.toString()}
            sub="負の資産化"
          />
        </div>
      </SectionBox>

      {/* 進行中の実験 */}
      {status.inProgress.length > 0 && (
        <SectionBox title="進行中の検証">
          <div className="space-y-4">
            {status.inProgress.map((exp) => (
              <div
                key={exp.obsId}
                className="border border-fg-3 dark:border-fg-3 rounded-lg p-4"
              >
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-600">{exp.obsId}</h3>
                  {exp.obsId === 'OBS000032' && (
                    <span className="text-sm text-amber-600 dark:text-amber-400">
                      Day90 カウントダウン
                    </span>
                  )}
                </div>
                <p className="text-body text-fg-2 dark:text-fg-2 mb-3">{exp.name}</p>

                {exp.day90Progress !== undefined && (
                  <div className="mb-3">
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span>進捗</span>
                      <span className="font-600">
                        {Math.round(exp.day90Progress)}%
                      </span>
                    </div>
                    <div className="w-full bg-fg-4 rounded-full h-2">
                      <div
                        className="bg-blue-500 h-2 rounded-full transition-all"
                        style={{ width: `${Math.min(100, exp.day90Progress)}%` }}
                      />
                    </div>
                  </div>
                )}

                <p className="text-sm text-fg-3 dark:text-fg-3">
                  {exp.details}
                </p>
              </div>
            ))}
          </div>
        </SectionBox>
      )}

      {/* 採用済み実験 */}
      {status.adopted.length > 0 && (
        <SectionBox title="採用済み実験（本番反映）">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {status.adopted.map((exp) => (
              <div
                key={exp.obsId}
                className="border-l-4 border-emerald-500 bg-emerald-50 dark:bg-emerald-950/20 p-4 rounded"
              >
                <h4 className="font-600 text-emerald-700 dark:text-emerald-400 mb-1">
                  {exp.obsId}
                </h4>
                <p className="text-sm text-fg-2 dark:text-fg-2 mb-2">{exp.name}</p>
                {exp.conclusion && (
                  <p className="text-xs text-fg-3 dark:text-fg-3">
                    {exp.conclusion}
                  </p>
                )}
              </div>
            ))}
          </div>
        </SectionBox>
      )}

      {/* 不採用実験 */}
      {status.rejected.length > 0 && (
        <SectionBox title="不採用実験（教訓の資産化）">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {status.rejected.slice(0, 6).map((exp) => (
              <div
                key={exp.obsId}
                className="border-l-4 border-red-500 bg-red-50 dark:bg-red-950/20 p-4 rounded"
              >
                <h4 className="font-600 text-red-700 dark:text-red-400 mb-1">
                  {exp.obsId}
                </h4>
                <p className="text-sm text-fg-2 dark:text-fg-2 mb-2">{exp.name}</p>
                {exp.conclusion && (
                  <p className="text-xs text-fg-3 dark:text-fg-3 line-clamp-2">
                    {exp.conclusion}
                  </p>
                )}
              </div>
            ))}
            {status.rejected.length > 6 && (
              <div className="text-center text-sm text-fg-3 dark:text-fg-3">
                他 {status.rejected.length - 6} 件
              </div>
            )}
          </div>
        </SectionBox>
      )}
    </div>
  );
};
