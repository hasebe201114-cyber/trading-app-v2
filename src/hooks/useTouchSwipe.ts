import { useRef } from 'react';

interface TouchSwipeHandlers {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
}

export function useTouchSwipe(
  onSwipeLeft: () => void,
  onSwipeRight: () => void,
  threshold: number = 50
): { handlers: TouchSwipeHandlers } {
  const touchStartXRef = useRef(0);

  const handlers: TouchSwipeHandlers = {
    onTouchStart: (e: React.TouchEvent) => {
      touchStartXRef.current = e.touches[0].clientX;
    },
    onTouchEnd: (e: React.TouchEvent) => {
      const touchEndX = e.changedTouches[0].clientX;
      const deltaX = touchEndX - touchStartXRef.current;

      if (deltaX < -threshold) {
        onSwipeLeft();
      } else if (deltaX > threshold) {
        onSwipeRight();
      }
    },
  };

  return { handlers };
}
