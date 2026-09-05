import { PAGE_TYPES } from "./schema";
import type { PageType } from "./schema";
/** Only explicit schema-kind namespaces establish a type; an address is not a person. */
export function subjectPageType(subject: string): PageType {
  const separator = subject.indexOf(":");
  if (separator < 1 || separator === subject.length - 1) {
    return "topic";
  }
  const namespace = subject.slice(0, separator);
  return (PAGE_TYPES as readonly string[]).includes(namespace) ? namespace as PageType : "topic";
}
