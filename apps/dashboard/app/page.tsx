import { redirect } from 'next/navigation';

/** Signing in lands on job search; the previous home dashboard stays available at /overview. */
export default function RootPage() {
  redirect('/searches');
}
