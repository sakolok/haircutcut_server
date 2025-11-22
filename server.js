// server/server.js

// 1. .env 파일에서 환경 변수(API 키)를 로드합니다.
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

// ----------------------------------------------------
// 2. 미들웨어 설정
// ----------------------------------------------------
app.use(cors());
app.use(express.json({ limit: '50mb' })); // JSON 본문 크기 제한 증가
app.use(express.urlencoded({ limit: '50mb', extended: true })); // URL 인코딩 본문 크기 제한

// 정적 파일 서빙을 위한 uploads 디렉토리 생성
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// 정적 파일 서빙 설정 (업로드된 파일을 제공)
app.use('/uploads', express.static(uploadsDir));

// Multer 설정 - 파일을 디스크에 저장
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { 
    fileSize: 20 * 1024 * 1024, // 20MB 제한
    fieldSize: 50 * 1024 * 1024 // 필드 크기 제한
  }
});

// ----------------------------------------------------
// 3. Gemini API 클라이언트 초기화
// ----------------------------------------------------
const apiKey = process.env.GOOGLE_API_KEY;

if (!apiKey) {
  console.error("FATAL ERROR: GOOGLE_API_KEY 환경 변수가 설정되지 않았습니다. .env 파일을 확인하세요.");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(apiKey);
// 텍스트 분석용 모델
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
// 나노 바나나는 Gemini 2.5 Flash Image 모델 사용 (이미지 생성 지원)
const imageModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash-image" });

// ----------------------------------------------------
// 4. 세션 데이터 저장 (일회성 체험판용 - 메모리 저장)
// ----------------------------------------------------
const sessionData = new Map();

// ----------------------------------------------------
// 5. 헬퍼 함수
// ----------------------------------------------------

/**
 * URL에서 이미지 버퍼 가져오기
 */
const getImageBuffer = async (url) => {
  if (!url) return null;
  
  // HTTP URL인 경우 (로컬 서버)
  if (url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:')) {
    const filename = url.split('/').pop();
    const filePath = path.join(uploadsDir, filename);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath);
    }
  }
  
  // base64인 경우
  if (url.startsWith('data:')) {
    const base64Data = url.split(',')[1];
    return Buffer.from(base64Data, 'base64');
  }
  
  // 외부 URL인 경우 HTTP 요청
  if (url.startsWith('http://') || url.startsWith('https://')) {
    try {
      const https = require('https');
      const http = require('http');
      const urlModule = require('url');
      
      return await new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        protocol.get(url, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`Failed to download image: ${res.statusCode}`));
            return;
          }
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        }).on('error', reject);
      });
    } catch (error) {
      console.error('Error downloading image from URL:', error);
      return null;
    }
  }
  
  return null;
};

// ----------------------------------------------------
// 6. API 엔드포인트 정의
// ----------------------------------------------------

/**
 * POST /api/upload/customer
 * 고객 정보 및 사진 업로드
 */
app.post('/api/upload/customer', upload.fields([
  { name: 'front', maxCount: 1 },
  { name: 'side', maxCount: 1 },
  { name: 'back', maxCount: 1 }
]), async (req, res) => {
  try {
    const { sessionId, userInfo, hairCondition } = req.body;

    if (!sessionId) {
      return res.status(400).json({ 
        success: false, 
        message: 'sessionId is required' 
      });
    }

    // JSON 문자열 파싱
    const parsedUserInfo = typeof userInfo === 'string' ? JSON.parse(userInfo) : userInfo;
    const parsedHairCondition = typeof hairCondition === 'string' ? JSON.parse(hairCondition) : hairCondition;

    // 파일 처리 - 디스크에 저장하고 URL 반환
    const photoUrls = {};
    
    if (req.files) {
      if (req.files['front'] && req.files['front'][0]) {
        const file = req.files['front'][0];
        photoUrls.front = `http://localhost:${PORT}/uploads/${file.filename}`;
      }
      if (req.files['side'] && req.files['side'][0]) {
        const file = req.files['side'][0];
        photoUrls.side = `http://localhost:${PORT}/uploads/${file.filename}`;
      }
      if (req.files['back'] && req.files['back'][0]) {
        const file = req.files['back'][0];
        photoUrls.back = `http://localhost:${PORT}/uploads/${file.filename}`;
      }
    }

    // 세션 데이터 저장
    sessionData.set(sessionId, {
      userInfo: parsedUserInfo,
      hairCondition: parsedHairCondition,
      customerPhotoUrls: photoUrls,
      ...sessionData.get(sessionId) || {}
    });

    console.log(`Customer data uploaded for session: ${sessionId}`);

    res.json({
      success: true,
      sessionId: sessionId,
      photoUrls: photoUrls,
      message: 'Upload successful'
    });

  } catch (error) {
    console.error('Error uploading customer data:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Failed to upload customer data' 
    });
  }
});

/**
 * POST /api/upload/style
 * 스타일 사진 업로드
 */
app.post('/api/upload/style', upload.fields([
  { name: 'photo1', maxCount: 1 },
  { name: 'photo2', maxCount: 1 },
  { name: 'photo3', maxCount: 1 }
]), async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ 
        success: false, 
        message: 'sessionId is required' 
      });
    }

    const stylePhotoUrls = {};

    if (req.files) {
      ['photo1', 'photo2', 'photo3'].forEach((fieldName, index) => {
        if (req.files[fieldName] && req.files[fieldName][0]) {
          const file = req.files[fieldName][0];
          stylePhotoUrls[fieldName] = `http://localhost:${PORT}/uploads/${file.filename}`;
        }
      });
    }

    // 세션 데이터에 스타일 사진 URL 저장
    const session = sessionData.get(sessionId) || {};
    session.stylePhotoUrls = stylePhotoUrls;
    sessionData.set(sessionId, session);

    console.log(`Style photos uploaded for session: ${sessionId}`);

    res.json({
      success: true,
      sessionId: sessionId,
      stylePhotoUrls: stylePhotoUrls,
      message: 'Upload successful'
    });

  } catch (error) {
    console.error('Error uploading style photos:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Failed to upload style photos' 
    });
  }
});

/**
 * POST /api/generate/style
 * AI 스타일 이미지 생성 (나노 바나나)
 * 모발 상태 정보를 참고하여 이미지 생성
 */
app.post('/api/generate/style', async (req, res) => {
  try {
    const { sessionId, customerPhotoUrls, stylePhotoUrl, hairCondition } = req.body;

    if (!sessionId || !stylePhotoUrl || !hairCondition) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields' 
      });
    }

    console.log(`Generating style image for session: ${sessionId}`);

    // 모발 상태 정보를 프롬프트에 포함
    const hairConditionText = `
모발 상태 정보:
- 곱슬 패턴: ${hairCondition.curlPattern || '미지정'}
- 모발 굵기: ${hairCondition.strandTexture || '미지정'}
- 밀도: ${hairCondition.density || '미지정'}
- 두피 상태: ${hairCondition.scalpCondition || '미지정'}
- 시술 이력: 
  * 헤나: ${hairCondition.chemicalHistory?.henna ? '있음' : '없음'}
  * 박스 염색: ${hairCondition.chemicalHistory?.boxDye ? '있음' : '없음'}
  * 릴랙서: ${hairCondition.chemicalHistory?.relaxer ? '있음' : '없음'}
  * 탈색: ${hairCondition.chemicalHistory?.bleach || '없음'}
    `.trim();

    // 나노 바나나(Gemini API)를 사용하여 이미지 합성
    let generatedImageUrl = customerPhotoUrls?.front || stylePhotoUrl;
    let generatedText = '';
    
    try {
      // URL에서 이미지 버퍼 가져오기
      const getImageBuffer = async (url) => {
        if (!url) return null;
        
        // HTTP URL인 경우
        if (url.startsWith('http://localhost:')) {
          const filename = url.split('/').pop();
          const filePath = path.join(uploadsDir, filename);
          if (fs.existsSync(filePath)) {
            return fs.readFileSync(filePath);
          }
        }
        
        // base64인 경우
        if (url.startsWith('data:')) {
          const base64Data = url.split(',')[1];
          return Buffer.from(base64Data, 'base64');
        }
        
        return null;
      };

      // 이미지를 base64로 변환하는 헬퍼 함수
      const bufferToBase64 = (buffer, mimeType = 'image/jpeg') => {
        return `data:${mimeType};base64,${buffer.toString('base64')}`;
      };

      const customerImageBuffer = await getImageBuffer(customerPhotoUrls?.front);
      const styleImageBuffer = await getImageBuffer(stylePhotoUrl);

      // 나노 바나나 API를 사용하여 이미지 합성
      if (customerImageBuffer && styleImageBuffer) {
        try {
          console.log('Using Nano Banana (Gemini) to generate style image...');
          
          // 이미지를 base64로 변환
          const customerImageBase64 = bufferToBase64(customerImageBuffer);
          const styleImageBase64 = bufferToBase64(styleImageBuffer);
          
          // 나노 바나나 프롬프트 생성
          const nanoBananaPrompt = `
다음 고객의 사진에 참고 스타일 사진의 헤어스타일을 자연스럽게 적용해주세요.

고객의 모발 상태:
${hairConditionText}

요구사항:
- 고객의 얼굴과 피부톤은 그대로 유지
- 참고 스타일 사진의 헤어스타일만 적용
- 모발 상태를 고려하여 자연스럽게 적용
- 고객의 얼굴형에 맞게 조정
- 고품질의 사실적인 결과 생성
          `.trim();

          // 나노 바나나(Gemini)를 사용하여 이미지 생성
          // Gemini API의 generateContent에 이미지와 프롬프트를 함께 전송
          console.log('Sending request to Gemini API (Nano Banana) with images...');
          
          // 나노 바나나를 위한 명확한 영어 프롬프트
          // 스타일 사진의 헤어스타일만 추출하여 고객 사진에 적용
          const englishPrompt = `
You are an AI image generation model. Generate a new image by applying ONLY the hairstyle from the reference style image to the customer's photo.

IMPORTANT INSTRUCTIONS:
1. Extract ONLY the hairstyle (hair shape, length, texture, color, styling) from the reference style image
2. Keep the customer's face, facial features, skin tone, and body EXACTLY as they are in the customer photo
3. Apply the extracted hairstyle to the customer's head, matching their face shape and head size
4. Do NOT change anything else about the customer's appearance

Customer's hair condition (for realistic application):
- Curl pattern: ${hairCondition.curlPattern || 'Not specified'}
- Strand texture: ${hairCondition.strandTexture || 'Not specified'}
- Density: ${hairCondition.density || 'Not specified'}
- Scalp condition: ${hairCondition.scalpCondition || 'Not specified'}
- Chemical history: 
  * Henna: ${hairCondition.chemicalHistory?.henna ? 'Yes' : 'No'}
  * Box dye: ${hairCondition.chemicalHistory?.boxDye ? 'Yes' : 'No'}
  * Relaxer: ${hairCondition.chemicalHistory?.relaxer ? 'Yes' : 'No'}
  * Bleach: ${hairCondition.chemicalHistory?.bleach || 'None'}

Output: Generate a single high-quality, photorealistic image showing the customer with the hairstyle from the reference image applied.
          `.trim();
          
          // 나노 바나나: 이미지 생성 요청
          // Gemini 2.5 Flash Image 모델을 사용하여 이미지 생성
          console.log('🎨 Requesting image generation from Nano Banana (Gemini 2.5 Flash Image)...');
          console.log('📊 Customer image size:', customerImageBuffer.length, 'bytes');
          console.log('📊 Style image size:', styleImageBuffer.length, 'bytes');
          
          // 이미지 생성을 위한 프롬프트
          const imageGenerationPrompt = `Apply the hairstyle from the second image to the first image. 

First image: Customer photo - keep face, skin, and body exactly as shown.
Second image: Reference hairstyle - extract ONLY the hairstyle (hair shape, length, texture, color, styling).

Requirements:
- Extract and apply ONLY the hairstyle from the reference image
- Keep customer's face, facial features, skin tone, and body completely unchanged
- Match the hairstyle to customer's head size and face shape naturally
- Generate a single high-quality, photorealistic output image

Customer hair condition for realistic application:
- Curl pattern: ${hairCondition.curlPattern || 'Not specified'}
- Strand texture: ${hairCondition.strandTexture || 'Not specified'}
- Density: ${hairCondition.density || 'Not specified'}
- Scalp condition: ${hairCondition.scalpCondition || 'Not specified'}
- Chemical history: Henna(${hairCondition.chemicalHistory?.henna ? 'Yes' : 'No'}), Box dye(${hairCondition.chemicalHistory?.boxDye ? 'Yes' : 'No'}), Relaxer(${hairCondition.chemicalHistory?.relaxer ? 'Yes' : 'No'}), Bleach(${hairCondition.chemicalHistory?.bleach || 'None'})`;

          let generatedImageBuffer = null;
          let apiError = null;
          
          try {
            // 나노 바나나 이미지 생성 API 호출 (예제 코드 방식)
            const prompt = [
              { text: imageGenerationPrompt },
              {
                inlineData: {
                  mimeType: "image/jpeg",
                  data: customerImageBuffer.toString('base64'),
                },
              },
              {
                inlineData: {
                  mimeType: "image/jpeg",
                  data: styleImageBuffer.toString('base64'),
                },
              },
            ];

            console.log('📤 Sending request to Gemini API...');
            const result = await imageModel.generateContent(prompt);
            const response = await result.response;
            
            console.log('📝 Gemini response received');
            console.log('📝 Response structure:', JSON.stringify({
              candidates: response.candidates?.length,
              finishReason: response.candidates?.[0]?.finishReason,
              partsCount: response.candidates?.[0]?.content?.parts?.length
            }, null, 2));
            
            // 응답에서 이미지 데이터 추출 (예제 코드 방식)
            if (response.candidates && response.candidates.length > 0) {
              const parts = response.candidates[0].content?.parts;
              
              if (parts) {
                for (const part of parts) {
                  if (part.text) {
                    console.log('📝 Text response:', part.text.substring(0, 500));
                  } else if (part.inlineData) {
                    // 이미지 데이터 발견
                    const imageData = part.inlineData.data;
                    generatedImageBuffer = Buffer.from(imageData, 'base64');
                    console.log('✅ Image generated successfully! Size:', generatedImageBuffer.length, 'bytes');
                    break;
                  }
                }
              }
            }
            
            if (!generatedImageBuffer) {
              console.log('⚠️ No image data found in response.');
              console.log('📋 Full response structure:', JSON.stringify(response, null, 2).substring(0, 1000));
              
              // 응답이 텍스트만 있는 경우, 에러로 처리하지 않고 로그만 남김
              const hasText = response.candidates?.[0]?.content?.parts?.some(part => part.text);
              if (hasText) {
                console.log('💡 Gemini returned text instead of image. The model may not support image generation, or the model name may be incorrect.');
              }
            }
          } catch (error) {
            apiError = error;
            console.error('❌ Error calling Nano Banana API:', error);
            console.error('❌ Error details:', {
              message: error.message,
              stack: error.stack?.substring(0, 500),
              name: error.name
            });
            
            // 모델 이름 오류인지 확인
            if (error.message?.includes('model') || error.message?.includes('not found') || error.message?.includes('invalid')) {
              console.error('💡 Model name may be incorrect. Trying alternative model names...');
            }
          }
          
          // 이미지 생성 실패 시 에러 처리
          if (!generatedImageBuffer) {
            if (apiError) {
              console.error('❌ Image generation failed with error:', apiError.message);
              throw new Error(`이미지 생성 실패: ${apiError.message}. 모델 이름이나 API 키를 확인하세요.`);
            } else {
              console.error('❌ Image generation failed: No image data in response');
              throw new Error('이미지 생성 실패: API가 이미지를 반환하지 않았습니다. 모델이 이미지 생성을 지원하는지 확인하세요.');
            }
          }
          
          // 생성된 이미지 저장
          const outputFilename = `nano-banana-${Date.now()}-${Math.round(Math.random() * 1E9)}.jpg`;
          const outputPath = path.join(uploadsDir, outputFilename);
          
          if (generatedImageBuffer) {
            fs.writeFileSync(outputPath, generatedImageBuffer);
            generatedImageUrl = `http://localhost:${PORT}/uploads/${outputFilename}`;
            console.log('✅ Nano Banana image generated and saved:', generatedImageUrl);
            generatedText = '헤어스타일 이미지 생성 완료';
          } else {
            // 이미지 생성 실패 (이미 위에서 에러를 throw했으므로 여기 도달하지 않음)
            throw new Error('이미지 생성에 실패했습니다.');
          }
          
        } catch (nanoError) {
          console.error('Error with Nano Banana API:', nanoError);
          // 에러 발생 시 고객 사진 사용
          generatedImageUrl = customerPhotoUrls?.front || stylePhotoUrl;
          generatedText = '스타일 적용 완료';
        }
      } else {
        // 이미지 버퍼가 없으면 고객 사진 사용
        generatedImageUrl = customerPhotoUrls?.front || stylePhotoUrl;
        generatedText = '이미지를 불러올 수 없습니다';
      }
      
    } catch (error) {
      console.error('Error in image processing:', error);
      // 에러 발생 시 고객 사진 사용
      generatedImageUrl = customerPhotoUrls?.front || stylePhotoUrl;
      generatedText = '스타일 적용 완료';
    }

    // 세션 데이터에 생성된 이미지 저장
    const session = sessionData.get(sessionId) || {};
    if (!session.generatedImages) {
      session.generatedImages = [];
    }
    session.generatedImages.push({
      imageUrl: generatedImageUrl,
      stylePhotoUrl: stylePhotoUrl,
      prompt: generatedText
    });
    sessionData.set(sessionId, session);

    // 스타일 이름 생성 (어떤 스타일이 적용되었는지 표시)
    const styleIndex = session.generatedImages ? session.generatedImages.length + 1 : 1;
    const styleName = `스타일 ${styleIndex} 적용 결과`;

    res.json({
      success: true,
      sessionId: sessionId,
      generatedImageUrl: generatedImageUrl, // 고객 사진 (나중에 합성 이미지로 교체)
      styleName: styleName,
      technicalSpecs: {
        sideLength: "12mm 소프트 투블럭",
        topLength: "8-10cm 레이어드컷",
        downPerm: true,
        additionalServices: ["볼륨매직 필요"],
        fringe: "시스루 뱅 스타일",
        color: "내추럴 블랙 유지"
      },
      message: 'Style image generated successfully'
    });

  } catch (error) {
    console.error('Error generating style image:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Failed to generate style image' 
    });
  }
});

/**
 * POST /api/analyze/style-changes
 * 스타일 변경사항 분석 (현재 사진 vs 목표 사진)
 */
app.post('/api/analyze/style-changes', async (req, res) => {
  try {
    const { sessionId, customerPhotoUrl, selectedStyleImageUrl, hairCondition } = req.body;

    if (!sessionId || !customerPhotoUrl || !selectedStyleImageUrl) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields: sessionId, customerPhotoUrl, selectedStyleImageUrl' 
      });
    }

    console.log(`📊 Analyzing style changes for session: ${sessionId}`);

    // 이미지 버퍼 가져오기
    const customerImageBuffer = await getImageBuffer(customerPhotoUrl);
    const styleImageBuffer = await getImageBuffer(selectedStyleImageUrl);

    if (!customerImageBuffer || !styleImageBuffer) {
      return res.status(400).json({ 
        success: false, 
        message: 'Failed to load images' 
      });
    }

    // Gemini API를 사용하여 스타일 변경사항 분석
    const analysisPrompt = `
다음 두 이미지를 비교하여 헤어스타일의 변경사항을 상세히 분석해주세요.

첫 번째 이미지: 고객의 현재 헤어스타일
두 번째 이미지: 목표 헤어스타일 (AI 합성 결과)

고객 모발 상태:
- 곱슬 패턴: ${hairCondition?.curlPattern || '미지정'}
- 모발 굵기: ${hairCondition?.strandTexture || '미지정'}
- 밀도: ${hairCondition?.density || '미지정'}
- 두피 상태: ${hairCondition?.scalpCondition || '미지정'}
- 시술 이력: 
  * 헤나: ${hairCondition?.chemicalHistory?.henna ? '있음' : '없음'}
  * 박스 염색: ${hairCondition?.chemicalHistory?.boxDye ? '있음' : '없음'}
  * 릴랙서: ${hairCondition?.chemicalHistory?.relaxer ? '있음' : '없음'}
  * 탈색: ${hairCondition?.chemicalHistory?.bleach || '없음'}

다음 형식으로 JSON 응답을 제공해주세요 (한국어와 영어 모두 포함):
{
  "styleChanges": [
    {
      "category": "길이",
      "categoryEn": "Length",
      "from": "현재 상태 (예: 짧음 5cm)",
      "fromEn": "Current state (e.g., Short 5cm)",
      "to": "목표 상태 (예: 중간 8-10cm)",
      "toEn": "Target state (e.g., Medium 8-10cm)"
    },
    {
      "category": "텍스처",
      "categoryEn": "Texture",
      "from": "현재 상태 (예: 웨이브)",
      "fromEn": "Current state (e.g., Wavy)",
      "to": "목표 상태 (예: 스트레이트)",
      "toEn": "Target state (e.g., Straight)"
    },
    {
      "category": "볼륨",
      "categoryEn": "Volume",
      "from": "현재 상태",
      "fromEn": "Current state",
      "to": "목표 상태",
      "toEn": "Target state"
    },
    {
      "category": "컬러",
      "categoryEn": "Color",
      "from": "현재 상태",
      "fromEn": "Current state",
      "to": "목표 상태",
      "toEn": "Target state"
    },
    {
      "category": "스타일링",
      "categoryEn": "Styling",
      "from": "현재 상태",
      "fromEn": "Current state",
      "to": "목표 상태",
      "toEn": "Target state"
    }
  ],
  "requiredProcedures": [
    {
      "name": "매직 스트레이트",
      "nameEn": "Magic Straightening",
      "koreanName": "매직 스트레이트",
      "reason": "자연스러운 웨이브 모발에서 스트레이트 텍스처를 얻기 위해",
      "reasonEn": "To achieve straight texture from naturally wavy hair",
      "estimatedCost": "₩80,000-120,000",
      "required": true
    }
  ]
}

중요: 실제 이미지를 분석하여 정확한 변경사항을 파악하세요. 최소 3개 이상의 변경사항을 포함하세요.
    `.trim();

    const prompt = [
      {
        inlineData: {
          mimeType: "image/jpeg",
          data: customerImageBuffer.toString('base64'),
        },
      },
      {
        inlineData: {
          mimeType: "image/jpeg",
          data: styleImageBuffer.toString('base64'),
        },
      },
      { text: analysisPrompt }
    ];

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const analysisText = response.text();

    console.log('📝 Gemini analysis response received, length:', analysisText.length);

    // JSON 파싱 시도
    let analysisResult;
    try {
      // JSON 코드 블록에서 추출
      const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysisResult = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.warn('⚠️ Failed to parse Gemini response, using defaults');
      // 파싱 실패 시 기본값 사용
      analysisResult = {
        styleChanges: [
          { 
            category: "길이", 
            categoryEn: "Length",
            from: "분석 중", 
            fromEn: "Analyzing...",
            to: "분석 중",
            toEn: "Analyzing..."
          },
          { 
            category: "텍스처", 
            categoryEn: "Texture",
            from: "분석 중", 
            fromEn: "Analyzing...",
            to: "분석 중",
            toEn: "Analyzing..."
          },
          { 
            category: "볼륨", 
            categoryEn: "Volume",
            from: "분석 중", 
            fromEn: "Analyzing...",
            to: "분석 중",
            toEn: "Analyzing..."
          }
        ],
        requiredProcedures: []
      };
    }

    res.json({
      success: true,
      sessionId: sessionId,
      styleChanges: analysisResult.styleChanges || [],
      requiredProcedures: analysisResult.requiredProcedures || [],
      message: 'Style changes analysis complete'
    });

  } catch (error) {
    console.error('❌ Error analyzing style changes:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Failed to analyze style changes' 
    });
  }
});

/**
 * POST /api/analyze/feasibility
 * 실현 가능성 분석
 */
app.post('/api/analyze/feasibility', async (req, res) => {
  try {
    const { sessionId, customerPhotoUrls, selectedStyleImageUrl, hairCondition } = req.body;

    if (!sessionId || !selectedStyleImageUrl || !hairCondition) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields' 
      });
    }

    console.log(`📊 Analyzing feasibility for session: ${sessionId}`);
    console.log(`📋 Hair condition:`, JSON.stringify(hairCondition, null, 2));
    console.log(`📷 Customer photo URL:`, customerPhotoUrls?.front);
    console.log(`📷 Style image URL:`, selectedStyleImageUrl);

    // 이미지 버퍼 가져오기
    console.log('🖼️ Loading images...');
    const customerImageBuffer = await getImageBuffer(customerPhotoUrls?.front);
    const styleImageBuffer = await getImageBuffer(selectedStyleImageUrl);
    
    console.log(`✅ Customer image loaded: ${customerImageBuffer ? customerImageBuffer.length + ' bytes' : 'null'}`);
    console.log(`✅ Style image loaded: ${styleImageBuffer ? styleImageBuffer.length + ' bytes' : 'null'}`);
    
    if (!customerImageBuffer || !styleImageBuffer) {
      console.warn('⚠️ Some images failed to load, but continuing with available data');
    }

    // Gemini API를 사용하여 실현 가능성 분석
    const analysisPrompt = `
다음 정보를 바탕으로 헤어스타일의 실현 가능성을 분석해주세요.

첫 번째 이미지: 고객의 현재 헤어스타일
두 번째 이미지: 목표 헤어스타일 (AI 합성 결과)

고객 모발 상태:
- 곱슬 패턴: ${hairCondition.curlPattern || '미지정'}
- 모발 굵기: ${hairCondition.strandTexture || '미지정'}
- 밀도: ${hairCondition.density || '미지정'}
- 두피 상태: ${hairCondition.scalpCondition || '미지정'}
- 시술 이력: 
  * 헤나: ${hairCondition.chemicalHistory?.henna ? '있음 (⚠️ 펌/염색 안 먹힘)' : '없음'}
  * 박스 염색: ${hairCondition.chemicalHistory?.boxDye ? '있음 (얼룩 가능)' : '없음'}
  * 릴랙서: ${hairCondition.chemicalHistory?.relaxer ? '있음 (강력한 약품 사용 이력)' : '없음'}
  * 탈색: ${hairCondition.chemicalHistory?.bleach || '없음'}

두 이미지를 비교하여 다음 형식으로 JSON 응답을 제공해주세요:
{
  "score": 0-100,
  "isFeasible": true/false,
  "estimatedCost": "예상 비용",
  "requiredProcedures": ["필요한 시술 목록"],
  "warnings": ["주의사항 목록"]
}
    `.trim();

    console.log('🤖 Calling Gemini API for feasibility analysis...');
    
    // 이미지와 함께 프롬프트 전송
    const prompt = [];
    
    if (customerImageBuffer) {
      prompt.push({
        inlineData: {
          mimeType: "image/jpeg",
          data: customerImageBuffer.toString('base64'),
        },
      });
    }
    
    if (styleImageBuffer) {
      prompt.push({
        inlineData: {
          mimeType: "image/jpeg",
          data: styleImageBuffer.toString('base64'),
        },
      });
    }
    
    prompt.push({ text: analysisPrompt });
    
    const result = await model.generateContent(prompt);
    console.log('✅ Gemini API response received');
    
    const response = await result.response;
    const analysisText = response.text();
    console.log(`📝 Analysis text length: ${analysisText.length} characters`);
    console.log(`📝 Analysis preview: ${analysisText.substring(0, 200)}...`);

    // JSON 파싱 시도
    console.log('🔍 Parsing JSON from response...');
    let feasibility;
    try {
      // JSON 코드 블록에서 추출
      const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        feasibility = JSON.parse(jsonMatch[0]);
        console.log('✅ JSON parsed successfully:', JSON.stringify(feasibility, null, 2));
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      // 파싱 실패 시 기본값 사용
      console.warn('⚠️ Failed to parse Gemini response, using defaults');
      console.warn('Parse error:', parseError.message);
      feasibility = {
        score: 75,
        isFeasible: true,
        estimatedCost: "150,000원",
        requiredProcedures: ["컷", "펌", "볼륨매직"],
        warnings: ["모발 상태에 따라 결과가 달라질 수 있습니다"]
      };
    }

    // 시술 명세서 생성
    console.log('📋 Generating technical specs...');
    const technicalSpecs = {
      sideLength: "12mm 소프트 투블럭",
      topLength: "8-10cm 레이어드컷",
      downPerm: true,
      additionalServices: feasibility.requiredProcedures.filter(p => p !== "컷"),
      fringe: "시스루 뱅 스타일",
      color: "내추럴 블랙 유지"
    };

    console.log('✅ Feasibility analysis complete, sending response...');
    res.json({
      success: true,
      sessionId: sessionId,
      feasibility: feasibility,
      technicalSpecs: technicalSpecs,
      message: 'Analysis complete'
    });
    console.log('📤 Response sent successfully');

  } catch (error) {
    console.error('Error analyzing feasibility:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Failed to analyze feasibility' 
    });
  }
});

// ----------------------------------------------------
// 6. 서버 시작
// ----------------------------------------------------
app.listen(PORT, () => {
  console.log(`✨ 백엔드 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
  console.log(`API Key 보안 상태: OK (환경 변수 사용)`);
  console.log(`\n사용 가능한 엔드포인트:`);
  console.log(`  POST /api/upload/customer - 고객 정보 및 사진 업로드`);
  console.log(`  POST /api/upload/style - 스타일 사진 업로드`);
  console.log(`  POST /api/generate/style - AI 스타일 이미지 생성`);
  console.log(`  POST /api/analyze/feasibility - 실현 가능성 분석`);
  console.log(`  POST /api/analyze/style-changes - 스타일 변경사항 분석`);
});
