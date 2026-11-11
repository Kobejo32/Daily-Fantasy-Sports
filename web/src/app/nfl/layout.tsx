import { UnderConstruction } from "@/components/under-construction";

export default function NFLLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <UnderConstruction sport="NFL" />
      <div className="pointer-events-none select-none opacity-30">
        {children}
      </div>
    </>
  );
}
