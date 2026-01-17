export const formatRecoveryPhrase = (mnemonic: string): { num: number; word: string }[][] => {
    const words = mnemonic.split(' ');
    const rows = [];
    for (let i = 0; i < 6; i++) {
      rows.push([
        { num: i + 1, word: words[i] || '' },
        { num: i + 7, word: words[i + 6] || '' },
        { num: i + 13, word: words[i + 12] || '' },
        { num: i + 19, word: words[i + 18] || '' },
      ]);
    }
    return rows;
  };
