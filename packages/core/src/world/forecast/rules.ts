import { exactCommitmentDue } from "../../contracts/world-vocab/commitment";
/** Exact date means the end of that UTC date, never an invented local timezone. */
export function deadlineInstant(due:string):string|null {
  if(!exactCommitmentDue(due))return null;
  return due.length===10 ? `${due}T23:59:59.999Z` : new Date(due).toISOString();
}
