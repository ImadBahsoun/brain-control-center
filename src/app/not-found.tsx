import Link from "next/link";

export default function NotFound() {
  return (
    <div className="py-10 text-center">
      <h1 className="label-md text-foreground">Not found</h1>
      <p className="mt-2 text-dim">There is nothing at this address.</p>
      <Link href="/" className="mt-4 inline-block text-signal">
        Back to the command map
      </Link>
    </div>
  );
}
