export const formatDeployTime = (deployTimeStr: string): string => {
  try {
    const [datePart, timePart] = deployTimeStr.split(' ');
    const [year, month, day] = datePart.split('/');
    const [hours, minutes] = timePart.split(':');

    const mmdd = `${String(parseInt(month)).padStart(2, '0')}/${String(parseInt(day)).padStart(2, '0')}`;
    return `${mmdd} ${hours}:${minutes}`;
  } catch {
    return '';
  }
};
