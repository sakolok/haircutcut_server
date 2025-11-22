# 서버 실행 가이드

## 환경 설정

1. `.env` 파일을 생성하고 Google API 키를 추가하세요:
```
GOOGLE_API_KEY=your_google_api_key_here
```

2. 필요한 패키지 설치:
```bash
npm install
```

## 서버 실행

```bash
npm start
```

또는

```bash
node server.js
```

서버는 `http://localhost:3000`에서 실행됩니다.

## API 엔드포인트

- `POST /api/upload/customer` - 고객 정보 및 사진 업로드
- `POST /api/upload/style` - 스타일 사진 업로드
- `POST /api/generate/style` - AI 스타일 이미지 생성
- `POST /api/analyze/feasibility` - 실현 가능성 분석

## 주의사항

1. 현재는 파일을 메모리에 저장하고 base64로 반환합니다. 실제 배포 시에는 S3로 업로드하도록 수정해야 합니다.
2. 세션 데이터는 메모리에 저장되므로 서버 재시작 시 데이터가 사라집니다.
3. 나노 바나나 이미지 생성 API는 아직 연동되지 않았습니다. TODO 주석을 참고하세요.

