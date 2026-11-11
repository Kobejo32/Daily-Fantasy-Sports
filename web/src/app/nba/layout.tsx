import { UnderConstruction } from "@/components/under-construction";

export default function NBALayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <UnderConstruction sport="NBA" />
      <div className="pointer-events-none select-none opacity-30">
        {children}
      </div>
    </>
  );
}
