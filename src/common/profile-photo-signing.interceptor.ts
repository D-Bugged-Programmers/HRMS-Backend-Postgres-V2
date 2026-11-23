// Purpose: turns a stored profile-photo key into a link the browser can load, in the lists that show people's faces next to their name.
// Responsibilities: on the listed routes (approvals, payroll, performance, attendance...), any `profileImage` that is still a storage key
//   in the response is replaced by a signed /files/... link (6-hour, like the Employee Directory's), so each list only has to SELECT the
//   photo. A value that is already a link (/files/..., http...) is left alone, so nothing is signed twice.
// Important: limited to the routes below. Employee profile / edit routes are not touched, because they hand the raw key back on save.
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { signProfilePhotoLink } from '../files/file-token';

const ROUTES = /^\/(leaves|leave-encashments|loans|reimbursements|comp-offs|payroll|performance|performance-ratings|performance-reviews|attendance|overtime|dashboard|leave-tracker|offboarding|resignations|settlements|employees\/(probation-tracker|role-history))(\/|$)/;
const ALREADY_A_LINK = /^(https?:\/\/|\/files\/)/i;

/** Signs every raw `profileImage` key found in the response, in place (idempotent). */
export function signProfilePhotos(value: unknown, organizationId: string, depth = 0): void {
  if (depth > 10 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) signProfilePhotos(item, organizationId, depth + 1);
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return; // dates, buffers, streams...
  const obj = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(obj)) {
    if (key === 'profileImage') {
      if (typeof child === 'string' && child !== '' && !ALREADY_A_LINK.test(child)) {
        obj[key] = signProfilePhotoLink(organizationId, child);
      }
    } else if (child && typeof child === 'object') {
      signProfilePhotos(child, organizationId, depth + 1);
    }
  }
}

@Injectable()
export class ProfilePhotoSigningInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request & { user?: { organizationId?: string } }>();
    const orgId = req.user?.organizationId;
    if (!orgId || !ROUTES.test(req.path ?? '')) return next.handle();
    return next.handle().pipe(
      map((body) => {
        signProfilePhotos(body, orgId);
        return body;
      }),
    );
  }
}
