import { redirect } from 'next/navigation';

/** Start in the overview so the next useful action is clear after sign-in. */
export default function RootPage() {
  redirect('/overview');
}
