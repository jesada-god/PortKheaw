import Image from 'next/image';
import { cn } from '@/src/utils/cn';

export function BrandMark({
  className,
  priority = false,
}: {
  className?: string;
  priority?: boolean;
}) {
  return (
    <Image
      src="/brand/kheaw-mark.png"
      alt=""
      aria-hidden="true"
      width={960}
      height={960}
      priority={priority}
      sizes="40px"
      className={cn('block shrink-0 object-contain', className)}
    />
  );
}
