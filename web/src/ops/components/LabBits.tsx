import type { Lab } from '../../api/types';
import { DIFFICULTY_META } from '../labs';

export function DifficultyBadge({ lab }: { lab: Lab }) {
  const meta = DIFFICULTY_META[lab.difficulty];
  return (
    <span className={`diff diff-${lab.difficulty}`}>
      <span aria-hidden="true" className="diff-dots">
        {meta.icon}
      </span>{' '}
      {meta.label}
    </span>
  );
}
